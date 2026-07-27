import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  canBurnSubtitles,
  FfmpegRenderProvider,
  MISSING_LIBASS_MESSAGE,
} from '@/lib/providers/ffmpeg/render';

/**
 * Phase 4 AC #2 — the output is exactly 1080x1920, 30fps, H.264 + AAC.
 *
 * This runs a real encode and interrogates the result with ffprobe, because the
 * only way to know what the container actually holds is to look. Skips when
 * ffmpeg is not installed rather than passing vacuously:
 *
 *   brew install ffmpeg        # macOS
 *   apt install ffmpeg         # Debian/Ubuntu
 *
 * Set FFMPEG_PATH if it lives somewhere unusual.
 */

const run = promisify(execFile);

const ffmpegBin = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run(ffmpegBin, ['-version']);
    await run(ffprobeBin, ['-version']);
    return true;
  } catch {
    return false;
  }
}

const available = await hasFfmpeg();

/**
 * Burning captions needs the `subtitles` filter, which needs libass. Homebrew's
 * current ffmpeg bottle ships without it, so the format assertions (AC #2) and
 * the burn-in assertion are separate tests — the former is the acceptance
 * criterion and must always run when ffmpeg exists.
 */
const canBurn = available ? await canBurnSubtitles() : false;

let workDir: string;
let clipA: string;
let clipB: string;
let voice: string;

interface ProbeStream {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
}

async function probe(path: string): Promise<{ streams: ProbeStream[]; format: { format_name?: string; duration?: string } }> {
  const { stdout } = await run(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    path,
  ]);
  return JSON.parse(stdout);
}

describe.skipIf(!available).sequential('ffmpeg adapter — real encode (AC #2)', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sds-encode-test-'));

    // Two synthetic source clips at a *different* resolution and frame rate from
    // the target, so the test proves the adapter conforms them rather than
    // passing through something that happened to be right already.
    clipA = join(workDir, 'a.mp4');
    clipB = join(workDir, 'b.mp4');
    voice = join(workDir, 'v.wav');

    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clipA,
    ]);
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clipB,
    ]);
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'pcm_s16le', '-y', voice,
    ]);
  }, 240_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('AC #2 — produces exactly 1080x1920 H.264 + AAC at 30fps', async () => {
    const provider = new FfmpegRenderProvider();

    const { providerJobId } = await provider.render({
      clips: [
        { url: `file://${clipA}`, durationSeconds: 3, startAt: 0 },
        { url: `file://${clipB}`, durationSeconds: 3, startAt: 3 },
      ],
      voiceTracks: [{ url: `file://${voice}`, startAt: 0 }],
      captions: [],
      aspectRatio: '9:16',
      resolution: '1080x1920',
    });

    const result = await provider.poll(providerJobId);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    if (result.status !== 'ready') return;

    const path = result.url.replace('file://', '');
    const info = await probe(path);

    const video = info.streams.find((s) => s.codec_type === 'video');
    const audio = info.streams.find((s) => s.codec_type === 'audio');

    // Exactly the vertical frame, from two differently-shaped sources.
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(video?.codec_name).toBe('h264');
    expect(video?.r_frame_rate).toBe('30/1');

    // Audio present and AAC.
    expect(audio?.codec_name).toBe('aac');

    expect(info.format.format_name).toMatch(/mp4/);

    // Two 3-second slots.
    expect(Number(info.format.duration)).toBeGreaterThan(5.5);
    expect(Number(info.format.duration)).toBeLessThan(6.6);

    await provider.cleanup(providerJobId);
  }, 600_000);

  it('renders silently when there is no audio at all', async () => {
    const provider = new FfmpegRenderProvider();

    const { providerJobId } = await provider.render({
      clips: [{ url: `file://${clipA}`, durationSeconds: 3, startAt: 0 }],
      voiceTracks: [],
      captions: [],
      aspectRatio: '9:16',
      resolution: '1080x1920',
    });

    const result = await provider.poll(providerJobId);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const info = await probe(result.url.replace('file://', ''));
    expect(info.streams.some((s) => s.codec_type === 'video')).toBe(true);
    expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(false);

    await provider.cleanup(providerJobId);
  }, 600_000);

  it('reports a missing input as a non-retryable failure', async () => {
    const provider = new FfmpegRenderProvider();

    const { providerJobId } = await provider.render({
      clips: [{ url: `file://${join(workDir, 'does-not-exist.mp4')}`, durationSeconds: 3, startAt: 0 }],
      voiceTracks: [],
      captions: [],
      aspectRatio: '9:16',
      resolution: '1080x1920',
    });

    const result = await provider.poll(providerJobId);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.retryable).toBe(false);
  }, 300_000);

  it('refuses an empty timeline before touching ffmpeg', async () => {
    await expect(
      new FfmpegRenderProvider().render({
        clips: [],
        voiceTracks: [],
        captions: [],
        aspectRatio: '9:16',
        resolution: '1080x1920',
      }),
    ).rejects.toThrow(/no clips/i);
  });

  it('treats an unknown job id as non-retryable, and says why', async () => {
    const result = await new FfmpegRenderProvider().poll('ffmpeg_nope');
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/in memory/i);
    }
  });

  it.skipIf(canBurn)('says what to install when this build cannot burn captions', async () => {
    const provider = new FfmpegRenderProvider();

    const { providerJobId } = await provider.render({
      clips: [{ url: `file://${clipA}`, durationSeconds: 3, startAt: 0 }],
      voiceTracks: [],
      captions: [{ text: 'You died in March.', startAt: 0.2, endAt: 2.5 }],
      aspectRatio: '9:16',
      resolution: '1080x1920',
    });

    const result = await provider.poll(providerJobId);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      // Actionable, rather than "No such filter: 'subtitles'" from deep in the
      // filtergraph.
      expect(result.error).toBe(MISSING_LIBASS_MESSAGE);
      expect(result.error).toMatch(/libass/);
      expect(result.retryable).toBe(false);
    }
  }, 300_000);

  it.skipIf(!canBurn)('AC #3 — burns captions in, at the target format', async () => {
    const provider = new FfmpegRenderProvider();

    const { providerJobId } = await provider.render({
      clips: [
        { url: `file://${clipA}`, durationSeconds: 3, startAt: 0 },
        { url: `file://${clipB}`, durationSeconds: 3, startAt: 3 },
      ],
      voiceTracks: [{ url: `file://${voice}`, startAt: 0 }],
      captions: [
        { text: 'You died in March.', startAt: 0.2, endAt: 2.5 },
        { text: 'I got better.', startAt: 3.2, endAt: 5.5 },
      ],
      aspectRatio: '9:16',
      resolution: '1080x1920',
    });

    const result = await provider.poll(providerJobId);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    if (result.status !== 'ready') return;

    const info = await probe(result.url.replace('file://', ''));
    const video = info.streams.find((s) => s.codec_type === 'video');

    // Burned in: one video stream, and no separate subtitle stream.
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(info.streams.some((s) => s.codec_type === 'subtitle')).toBe(false);

    await provider.cleanup(providerJobId);
  }, 600_000);

  /**
   * The assertions above are necessary but not sufficient: "the render succeeded
   * and holds no subtitle stream" is equally true of a render where the
   * `subtitles` filter ran and drew nothing at all. Burned-in captions are only
   * verified by looking at the pixels.
   *
   * So render the same timeline twice, with and without captions, and compare a
   * frame from a moment when a caption is on screen. The two frames must differ,
   * and they must differ *in the lower third*, where this app's caption style
   * places text — a difference confined to the top would mean something else
   * changed.
   */
  it.skipIf(!canBurn)('AC #3 — the captions are actually drawn on the frames', async () => {
    const provider = new FfmpegRenderProvider();

    const timeline = {
      clips: [{ url: `file://${clipA}`, durationSeconds: 3, startAt: 0 }],
      voiceTracks: [],
      aspectRatio: '9:16' as const,
      resolution: '1080x1920' as const,
    };

    const [withCaptions, without] = await Promise.all([
      provider.render({
        ...timeline,
        captions: [{ text: 'YOU DIED IN MARCH.', startAt: 0, endAt: 3 }],
      }),
      provider.render({ ...timeline, captions: [] }),
    ]);

    const [captioned, plain] = await Promise.all([
      provider.poll(withCaptions.providerJobId),
      provider.poll(without.providerJobId),
    ]);

    expect(captioned.status, JSON.stringify(captioned)).toBe('ready');
    expect(plain.status, JSON.stringify(plain)).toBe('ready');
    if (captioned.status !== 'ready' || plain.status !== 'ready') return;

    /** Mean luminance of a horizontal band, as a fraction of the frame height. */
    async function bandLuma(file: string, from: number, to: number): Promise<number> {
      const height = Math.round((to - from) * 1920);
      const y = Math.round(from * 1920);
      const { stdout, stderr } = await run(ffmpegBin, [
        '-hide_banner',
        '-ss',
        '1.5',
        '-i',
        file.replace('file://', ''),
        '-vf',
        `crop=1080:${height}:0:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      // `metadata=print` writes through av_log, which is stderr — not stdout.
      const match = /YAVG=([0-9.]+)/.exec(`${stderr}${stdout}`);
      if (!match) throw new Error(`no YAVG in ffmpeg output for ${file}`);
      return Number(match[1]);
    }

    // The caption band: clear of the bottom 12% platform-UI margin, which is
    // where `lib/captions.ts` puts the text.
    const [capBottom, plainBottom] = await Promise.all([
      bandLuma(captioned.url, 0.6, 0.88),
      bandLuma(plain.url, 0.6, 0.88),
    ]);

    // The top of the frame has no captions in either render, so it is the control:
    // if it also changed, the difference is not the captions.
    const [capTop, plainTop] = await Promise.all([
      bandLuma(captioned.url, 0.1, 0.35),
      bandLuma(plain.url, 0.1, 0.35),
    ]);

    const bottomDelta = Math.abs(capBottom - plainBottom);
    const topDelta = Math.abs(capTop - plainTop);

    expect(
      bottomDelta,
      `caption band luma barely moved (${plainBottom.toFixed(2)} -> ${capBottom.toFixed(2)}); ` +
        'the subtitles filter ran but appears to have drawn nothing',
    ).toBeGreaterThan(1);

    expect(
      bottomDelta,
      `the control band changed as much as the caption band ` +
        `(top ${topDelta.toFixed(2)} vs bottom ${bottomDelta.toFixed(2)}) — ` +
        'something other than captions differs between these renders',
    ).toBeGreaterThan(topDelta * 2);

    await Promise.all([
      provider.cleanup(withCaptions.providerJobId),
      provider.cleanup(without.providerJobId),
    ]);
  }, 600_000);
});

describe.skipIf(available)('ffmpeg encode suite', () => {
  it('is skipped without ffmpeg installed', () => {
    console.warn(
      `ffmpeg encode tests skipped: "${ffmpegBin}" not found. ` +
        'Install ffmpeg (brew install ffmpeg) to verify Phase 4 AC #2.',
    );
    expect(available).toBe(false);
  });
});
