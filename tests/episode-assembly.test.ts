import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FfmpegRenderProvider } from '@/lib/providers/ffmpeg/render';
import type { RenderInput } from '@/lib/providers';

/**
 * Phase 5 AC #1 and AC #3 — a real assembly, interrogated rather than trusted.
 *
 * Both criteria are about what is actually *in* the output file, and neither can
 * be shown by asserting on a filtergraph string: "the shots are in the right
 * order" means the frame at four seconds belongs to the second clip, and "the
 * music is audibly mixed" means there is sound where the dialogue is silent. So
 * this encodes for real and reads the result back with ffprobe and ffmpeg.
 *
 * Skips when ffmpeg is absent rather than passing vacuously.
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

const CLIP_SECONDS = 3;
const TOTAL_SECONDS = CLIP_SECONDS * 2;

let workDir: string;
let redClip: string;
let blueClip: string;
let voiceTrack: string;
let musicTrack: string;

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

async function probe(path: string): Promise<{
  streams: ProbeStream[];
  format: { duration?: string };
}> {
  const { stdout } = await run(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    path,
  ]);
  return JSON.parse(stdout);
}

/**
 * The dominant colour at a moment in the video.
 *
 * Scales one frame to a single pixel and reads its three bytes, which is a
 * blunt but completely unambiguous way to ask "which clip is on screen here".
 */
async function pixelAt(path: string, seconds: number): Promise<{ r: number; g: number; b: number }> {
  const out = join(workDir, `probe-${seconds}.raw`);
  await run(ffmpegBin, [
    '-ss', String(seconds),
    '-i', path,
    '-frames:v', '1',
    '-vf', 'scale=1:1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-y', out,
  ]);
  const bytes = await readFile(out);
  return { r: bytes[0]!, g: bytes[1]!, b: bytes[2]! };
}

/**
 * Mean volume over a slice, in dBFS.
 *
 * `-91` is ffmpeg's floor for digital silence; anything approaching it means
 * nothing is playing. Used to compare the same stretch of programme with and
 * without a music bed under it.
 */
async function meanVolumeDb(path: string, from: number, to: number): Promise<number> {
  const { stderr } = await run(ffmpegBin, [
    '-ss', String(from),
    '-to', String(to),
    '-i', path,
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`volumedetect reported nothing for ${path}`);
  return Number(match[1]);
}

/** A timeline of two clips back to back, optionally with a music bed. */
function timeline(options: { music?: boolean }): RenderInput {
  return {
    clips: [
      { url: pathToFileURL(redClip).href, durationSeconds: CLIP_SECONDS, startAt: 0 },
      { url: pathToFileURL(blueClip).href, durationSeconds: CLIP_SECONDS, startAt: CLIP_SECONDS },
    ],
    // Two seconds of speech at the very start, so the back half of the
    // programme has nothing in it but whatever bed is mixed under it.
    voiceTracks: [{ url: pathToFileURL(voiceTrack).href, startAt: 0 }],
    captions: [],
    aspectRatio: '9:16',
    resolution: '1080x1920',
    ...(options.music ? { musicUrl: pathToFileURL(musicTrack).href } : {}),
  };
}

async function assemble(input: RenderInput): Promise<string> {
  const provider = new FfmpegRenderProvider();
  const { providerJobId } = await provider.render(input);
  const result = await provider.poll(providerJobId);

  if (result.status !== 'ready') {
    throw new Error(
      `assembly did not finish: ${result.status === 'failed' ? result.error : 'still pending'}`,
    );
  }
  return fileURLToPath(result.url);
}

describe.skipIf(!available).sequential('episode assembly, encoded for real', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sds-assembly-'));
    redClip = join(workDir, 'red.mp4');
    blueClip = join(workDir, 'blue.mp4');
    voiceTrack = join(workDir, 'voice.wav');
    musicTrack = join(workDir, 'music.wav');

    // Solid colours, at a resolution and frame rate deliberately unlike the
    // target, so conforming is exercised and "which clip is this" is trivial.
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', `color=c=red:size=640x480:rate=24:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', redClip,
    ]);
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', `color=c=blue:size=1280x720:rate=25:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', blueClip,
    ]);
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'pcm_s16le', '-y', voiceTrack,
    ]);
    await run(ffmpegBin, [
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${TOTAL_SECONDS}`,
      '-c:a', 'pcm_s16le', '-y', musicTrack,
    ]);
  }, 240_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('AC #1 — one playable video, shots in order', () => {
    let output: string;

    beforeAll(async () => {
      output = await assemble(timeline({}));
    }, 240_000);

    it('is a single playable file of the right length', async () => {
      const probed = await probe(output);

      expect(probed.streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);
      expect(Number(probed.format.duration)).toBeCloseTo(TOTAL_SECONDS, 0);
    });

    it('conforms both sources to 1080x1920 H.264 at 30fps', async () => {
      const video = (await probe(output)).streams.find((s) => s.codec_type === 'video')!;

      expect(video.codec_name).toBe('h264');
      expect(video.width).toBe(1080);
      expect(video.height).toBe(1920);
      expect(video.r_frame_rate).toBe('30/1');
    });

    it('plays the shots in timeline order, not the order they arrived', async () => {
      // The first clip is red and the second blue, so the frame at 1s and the
      // frame at 4s answer "did they come out in the right order" outright.
      const first = await pixelAt(output, 1);
      const second = await pixelAt(output, TOTAL_SECONDS - 2);

      expect(first.r).toBeGreaterThan(150);
      expect(first.b).toBeLessThan(90);

      expect(second.b).toBeGreaterThan(150);
      expect(second.r).toBeLessThan(90);
    });
  });

  describe('AC #3 — a music bed is mixed in, not merely accepted', () => {
    let withMusic: string;
    let withoutMusic: string;

    beforeAll(async () => {
      withoutMusic = await assemble(timeline({}));
      withMusic = await assemble(timeline({ music: true }));
    }, 300_000);

    it('merges two sources into one audio stream, not two', async () => {
      const probed = await probe(withMusic);
      const audio = probed.streams.filter((s) => s.codec_type === 'audio');

      // The criterion exactly: two inputs went in, one stream came out. Two
      // streams would mean they were muxed side by side, which most players
      // would render as dialogue only.
      expect(audio).toHaveLength(1);
      expect(audio[0]!.codec_name).toBe('aac');
    });

    it('fills the stretch where nobody is speaking', async () => {
      // The voice stops at 2s. Everything after it is silence without a bed and
      // audible music with one — which is what "audibly mixed" means, and it
      // cannot be faked by writing a file.
      const silent = await meanVolumeDb(withoutMusic, CLIP_SECONDS, TOTAL_SECONDS);
      const scored = await meanVolumeDb(withMusic, CLIP_SECONDS, TOTAL_SECONDS);

      expect(silent).toBeLessThan(-60);
      expect(scored).toBeGreaterThan(silent + 30);
    });

    it('keeps the dialogue on top of the bed', async () => {
      // Over the spoken stretch the mix must still be dominated by the voice.
      // A bed at -18dB moves this by a fraction of a dB, not by a lot.
      const speechOnly = await meanVolumeDb(withoutMusic, 0, 2);
      const speechOverBed = await meanVolumeDb(withMusic, 0, 2);

      expect(Math.abs(speechOverBed - speechOnly)).toBeLessThan(6);
    });

    it('still produces one video stream of the right shape', async () => {
      const video = (await probe(withMusic)).streams.find((s) => s.codec_type === 'video')!;
      expect(video.width).toBe(1080);
      expect(video.height).toBe(1920);
    });
  });
});

describe.skipIf(available)('episode assembly suite', () => {
  it('is skipped without ffmpeg installed', () => {
    console.warn('Skipped: install ffmpeg (brew install ffmpeg) to run the assembly tests.');
    expect(available).toBe(false);
  });
});
