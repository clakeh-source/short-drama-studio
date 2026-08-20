import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderResult, RenderInput, RenderProvider } from '../types';
import { buildAssSubtitles, resolveCaptionStyle } from '../../captions';
import type { TimelineCaption } from '../../timeline';

/**
 * Local ffmpeg render adapter — the fallback implementation.
 *
 * Encodes to the spec exactly: 1080x1920 @ 30fps, H.264 (`libx264 -crf 20
 * -preset medium`) + AAC, audio normalised to -14 LUFS, subtitles burned in via
 * the `subtitles` filter.
 *
 * Unlike the cloud adapters this does the work in-process. `render()` awaits the
 * encode and `poll()` then reports the finished file, which keeps it inside the
 * same async interface without pretending to have durable server-side jobs: if
 * the process dies mid-encode the job is lost and has to be restarted. That is
 * the trade for having no external dependency, and it is why the cloud adapter
 * is the default.
 */

interface FfmpegJob {
  id: string;
  outputPath: string;
  workDir: string;
  status: 'running' | 'ready' | 'failed';
  error?: string;
  durationSeconds: number;
}

const jobs = new Map<string, FfmpegJob>();

/** Local encoding costs nothing but electricity. */
const COST_CENTS = 0;

/**
 * How far the music bed sits under the dialogue, in decibels.
 *
 * Expressed in dB rather than as a linear gain because that is the unit the
 * requirement is written in and the unit anyone adjusting it will think in:
 * "a bit quieter" means 3dB to a human and an unmemorable multiplication to a
 * filtergraph. -18dB is roughly 0.126 linear — quiet enough that speech stays
 * intelligible over it, loud enough to be audibly there.
 *
 * The mix happens *before* `loudnorm`, so this is a ratio between the two
 * sources, not an absolute output level: the normaliser then brings the whole
 * mix to -14 LUFS with the balance preserved.
 */
export const DEFAULT_MUSIC_LEVEL_DB = -18;

export function musicLevelDb(): number {
  const raw = process.env.MUSIC_BED_LEVEL_DB?.trim();
  if (!raw) return DEFAULT_MUSIC_LEVEL_DB;

  const parsed = Number(raw);
  // Above 0dB the bed is louder than the dialogue, which is never what anyone
  // means; silently clamping would hide a typo, so refuse it.
  if (!Number.isFinite(parsed) || parsed > 0) {
    throw new Error(
      `MUSIC_BED_LEVEL_DB="${raw}" is not a number at or below 0. It is how far the music ` +
        `sits *under* the dialogue, e.g. -18.`,
    );
  }
  return parsed;
}

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // ffmpeg writes progress to stderr; keep only the tail for diagnostics.
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });

    child.on('error', (error) => {
      reject(
        new Error(
          `Could not start ffmpeg at "${ffmpegPath()}". Install it, or set FFMPEG_PATH. (${error.message})`,
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited with code ${code}:\n${stderr}`));
    });
  });
}

/**
 * Whether this ffmpeg can burn subtitles.
 *
 * The `subtitles` filter needs libass, and plenty of builds ship without it —
 * Homebrew's current bottle among them. Without this check the render fails deep
 * in the filtergraph with "No such filter: 'subtitles'", which tells the user
 * nothing about what to install.
 *
 * Cached: the answer cannot change while the process is running.
 */
let subtitlesFilterAvailable: boolean | null = null;

export async function canBurnSubtitles(): Promise<boolean> {
  if (subtitlesFilterAvailable !== null) return subtitlesFilterAvailable;
  try {
    const { stdout } = await run(['-hide_banner', '-filters'], process.cwd());
    subtitlesFilterAvailable = /^\s*\S+\s+subtitles\s/m.test(stdout);
  } catch {
    subtitlesFilterAvailable = false;
  }
  return subtitlesFilterAvailable;
}

/** Test seam. */
export function resetSubtitleCapabilityCache(): void {
  subtitlesFilterAvailable = null;
}

export const MISSING_LIBASS_MESSAGE =
  'This ffmpeg build has no `subtitles` filter, so captions cannot be burned in. ' +
  'It needs to be built with libass. On macOS: ' +
  '`brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-libass`. ' +
  'Alternatively set RENDER_PROVIDER=shotstack to render in the cloud.';

async function download(url: string, destination: string): Promise<void> {
  // Local files (from a previous stage) can be copied straight through.
  if (url.startsWith('file://')) {
    await writeFile(destination, await readFile(new URL(url)));
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url.slice(0, 80)} (${response.status}).`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/* -------------------------------------------------------------------------- */
/* Filter graph                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Builds the filter graph.
 *
 * Video: every clip is scaled to fill 1080x1920, centre-cropped, forced to
 * 30fps and to a common pixel format, then concatenated. Scaling per-input
 * rather than once at the end is what lets clips of mixed provider resolutions
 * cut together without a jump.
 *
 * Audio: each voice track is delayed to its position, all are mixed, and the
 * result is normalised to -14 LUFS — the loudness every short-form platform
 * targets, so the episode does not arrive quieter than everything around it.
 */
export function buildFilterGraph(input: {
  clipCount: number;
  voice: Array<{ inputIndex: number; startAt: number }>;
  musicInputIndex: number | null;
  subtitlesFile: string | null;
  totalSeconds: number;
  /** How far under the dialogue the bed sits. Defaults to -18dB. */
  musicLevelDb?: number;
}): { filter: string; videoLabel: string; audioLabel: string | null } {
  const parts: string[] = [];

  for (let i = 0; i < input.clipCount; i++) {
    parts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,fps=30,format=yuv420p,setsar=1[v${i}]`,
    );
  }

  const concatInputs = Array.from({ length: input.clipCount }, (_, i) => `[v${i}]`).join('');
  parts.push(`${concatInputs}concat=n=${input.clipCount}:v=1:a=0[vcat]`);

  let videoLabel = '[vcat]';
  if (input.subtitlesFile) {
    // `filename=` spelled out, and NOT single-quoted. Quotes inside a filter
    // description are consumed by the filtergraph parser before the filter sees
    // them, so `subtitles='captions.ass'` fails with "No option name near
    // 'captions.ass'". The caller always passes a bare generated name in the
    // working directory, so there is nothing needing escaping.
    parts.push(`[vcat]subtitles=filename=${input.subtitlesFile}[vsub]`);
    videoLabel = '[vsub]';
  }

  let audioLabel: string | null = null;
  const audioLabels: string[] = [];

  for (const [n, track] of input.voice.entries()) {
    const delayMs = Math.round(track.startAt * 1000);
    parts.push(
      `[${track.inputIndex}:a]aresample=48000,adelay=${delayMs}|${delayMs},` +
        `apad=whole_dur=${input.totalSeconds}[a${n}]`,
    );
    audioLabels.push(`[a${n}]`);
  }

  if (input.musicInputIndex !== null) {
    // `volume` takes a dB value directly when suffixed, which keeps the level
    // in the unit the requirement is stated in rather than a magic multiplier.
    parts.push(
      `[${input.musicInputIndex}:a]aresample=48000,volume=${input.musicLevelDb ?? DEFAULT_MUSIC_LEVEL_DB}dB,` +
        `atrim=0:${input.totalSeconds},apad=whole_dur=${input.totalSeconds}[amus]`,
    );
    audioLabels.push('[amus]');
  }

  if (audioLabels.length === 1) {
    parts.push(`${audioLabels[0]}loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
    audioLabel = '[aout]';
  } else if (audioLabels.length > 1) {
    parts.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:` +
        `dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    );
    audioLabel = '[aout]';
  }

  return { filter: parts.join(';'), videoLabel, audioLabel };
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class FfmpegRenderProvider implements RenderProvider {
  readonly id = 'ffmpeg';

  constructor() {
    /**
     * This adapter cannot work on Vercel, for two independent reasons: there is
     * no ffmpeg binary in the runtime, and `jobs` above is module-scope state
     * that a second invocation may not share — `render` and `poll` can land on
     * different instances, so the handle resolves to "unknown job" exactly as
     * the stubs did before they moved to encoded handles.
     *
     * Fail at selection rather than at render time. The alternative is an
     * episode that queues, spends its clips, and only then discovers it has
     * nowhere to be assembled.
     */
    if (process.env.VERCEL) {
      throw new Error(
        'RENDER_PROVIDER=ffmpeg cannot run on Vercel: there is no ffmpeg binary in the ' +
          'runtime and render jobs are held in memory. Use RENDER_PROVIDER=shotstack in ' +
          'production (see docs/DEPLOY.md).',
      );
    }
  }

  estimateCostCents(): number {
    return COST_CENTS;
  }

  async render(input: RenderInput): Promise<{ providerJobId: string }> {
    if (input.clips.length === 0) {
      throw new Error('Nothing to render — the timeline has no clips.');
    }

    const id = `ffmpeg_${crypto.randomUUID()}`;
    const workDir = await mkdtemp(join(tmpdir(), 'sds-render-'));
    const outputPath = join(workDir, 'episode.mp4');
    const totalSeconds = input.clips.reduce(
      (end, clip) => Math.max(end, clip.startAt + clip.durationSeconds),
      0,
    );

    const job: FfmpegJob = { id, outputPath, workDir, status: 'running', durationSeconds: totalSeconds };
    jobs.set(id, job);

    try {
      // 1. Pull every input local. ffmpeg can read URLs, but a mid-encode
      //    network stall is far harder to diagnose than a failed download.
      const args: string[] = [];
      const ordered = [...input.clips].sort((a, b) => a.startAt - b.startAt);

      for (const [i, clip] of ordered.entries()) {
        const local = join(workDir, `clip-${i}.mp4`);
        await download(clip.url, local);
        // Trim each clip to its slot so one long file cannot shift the timeline.
        args.push('-t', String(clip.durationSeconds), '-i', local);
      }

      const voice: Array<{ inputIndex: number; startAt: number }> = [];
      for (const [i, track] of input.voiceTracks.entries()) {
        const local = join(workDir, `voice-${i}.wav`);
        await download(track.url, local);
        args.push('-i', local);
        voice.push({ inputIndex: ordered.length + i, startAt: track.startAt });
      }

      let musicInputIndex: number | null = null;
      if (input.musicUrl) {
        const local = join(workDir, 'music.mp3');
        await download(input.musicUrl, local);
        args.push('-i', local);
        musicInputIndex = ordered.length + input.voiceTracks.length;
      }

      // 2. Captions, burned in — if this build can.
      let subtitlesFile: string | null = null;
      if (input.captions.length > 0) {
        if (!(await canBurnSubtitles())) {
          throw new Error(MISSING_LIBASS_MESSAGE);
        }
        const captions: TimelineCaption[] = input.captions.map((cue) => ({
          shotId: '',
          text: cue.text,
          startAt: cue.startAt,
          endAt: cue.endAt,
        }));
        const assPath = join(workDir, 'captions.ass');
        await writeFile(assPath, buildAssSubtitles(captions, resolveCaptionStyle()), 'utf8');
        // Relative, and cwd is the work dir — absolute paths on macOS contain a
        // colon-free but escape-prone prefix that the filter parser mangles.
        subtitlesFile = 'captions.ass';
      }

      const graph = buildFilterGraph({
        clipCount: ordered.length,
        voice,
        musicInputIndex,
        subtitlesFile,
        totalSeconds,
        musicLevelDb: musicLevelDb(),
      });

      args.push('-filter_complex', graph.filter);
      args.push('-map', graph.videoLabel);
      if (graph.audioLabel) {
        args.push('-map', graph.audioLabel);
        args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
      } else {
        args.push('-an');
      }

      args.push(
        '-c:v', 'libx264',
        '-crf', '20',
        '-preset', 'medium',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-s', '1080x1920',
        // Streaming-friendly: index at the front so playback can start early.
        '-movflags', '+faststart',
        '-y',
        outputPath,
      );

      await run(args, workDir);

      job.status = 'ready';
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    }

    return { providerJobId: id };
  }

  async poll(providerJobId: string): Promise<ProviderResult> {
    const job = jobs.get(providerJobId);

    if (!job) {
      return {
        status: 'failed',
        error:
          `Local render job ${providerJobId} is not known to this process. The ffmpeg adapter ` +
          `keeps job state in memory, so a restart loses it — start the render again.`,
        retryable: false,
      };
    }

    if (job.status === 'running') return { status: 'pending' };

    if (job.status === 'failed') {
      return {
        status: 'failed',
        error: job.error ?? 'ffmpeg failed for an unknown reason.',
        // A local encode failure is almost always the inputs or the install,
        // neither of which a retry fixes.
        retryable: false,
      };
    }

    return {
      status: 'ready',
      url: `file://${job.outputPath}`,
      costCents: COST_CENTS,
      meta: { adapter: 'ffmpeg', durationSeconds: job.durationSeconds, workDir: job.workDir },
    };
  }

  /** Removes a finished job's temp directory. Called after the file is stored. */
  async cleanup(providerJobId: string): Promise<void> {
    const job = jobs.get(providerJobId);
    if (!job) return;
    await rm(job.workDir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(providerJobId);
  }
}
