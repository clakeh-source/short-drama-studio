import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getRenderProvider,
  getTtsProvider,
  getVideoProvider,
  registeredProviderIds,
} from '@/lib/providers';
import type { RenderInput, VideoGenInput } from '@/lib/providers';
import { clearStubJobs, STUB_JOB_DURATION_MS } from '@/lib/providers/stub/support';
import { clampDuration } from '@/lib/providers/stub/video';

const videoInput: VideoGenInput = {
  prompt: 'close-up, a woman in a red coat turns to face the camera, rain-slick alley, night',
  negativePrompt: 'blurry, watermark, text',
  durationSeconds: 5,
  aspectRatio: '9:16',
};

const renderInput: RenderInput = {
  clips: [
    { url: 'https://example.test/a.mp4', durationSeconds: 5, startAt: 0 },
    { url: 'https://example.test/b.mp4', durationSeconds: 5, startAt: 5 },
  ],
  voiceTracks: [{ url: 'https://example.test/v.wav', startAt: 0 }],
  captions: [{ text: 'You lied to me.', startAt: 0, endAt: 2 }],
  aspectRatio: '9:16',
  resolution: '1080x1920',
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearStubJobs();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('provider registry (Phase 0 AC #6)', () => {
  it('resolves all three stubs when the env vars select them', () => {
    process.env.VIDEO_PROVIDER = 'stub';
    process.env.TTS_PROVIDER = 'stub';
    process.env.RENDER_PROVIDER = 'stub';

    expect(getVideoProvider().id).toBe('stub');
    expect(getTtsProvider().id).toBe('stub');
    expect(getRenderProvider().id).toBe('stub');
  });

  it('defaults to the stub when the env var is unset', () => {
    delete process.env.VIDEO_PROVIDER;
    delete process.env.TTS_PROVIDER;
    delete process.env.RENDER_PROVIDER;

    expect(getVideoProvider().id).toBe('stub');
    expect(getTtsProvider().id).toBe('stub');
    expect(getRenderProvider().id).toBe('stub');
  });

  it('fails loudly, naming the env var, when asked for an unknown provider', () => {
    expect(() => getVideoProvider('does-not-exist')).toThrow(/VIDEO_PROVIDER/);
    expect(() => getTtsProvider('does-not-exist')).toThrow(/TTS_PROVIDER/);
    expect(() => getRenderProvider('does-not-exist')).toThrow(/RENDER_PROVIDER/);
  });

  it('reports what is registered', () => {
    expect(registeredProviderIds()).toEqual({
      llm: ['stub', 'anthropic'],
      video: ['stub', 'replicate', 'fal'],
      image: ['stub', 'fal'],
      tts: ['stub', 'elevenlabs'],
      render: ['stub', 'shotstack', 'ffmpeg'],
    });
  });
});

describe('stub video provider', () => {
  it('estimates cost from the clamped duration', () => {
    const provider = getVideoProvider('stub');
    expect(clampDuration(7)).toBe(8);
    expect(provider.estimateCostCents({ ...videoInput, durationSeconds: 7 })).toBe(40);
  });

  it('is pending before it is ready, then reports a url and a cost', async () => {
    const provider = getVideoProvider('stub');
    const { providerJobId } = await provider.generate(videoInput);
    expect(providerJobId).toMatch(/^stubvid_/);

    expect(await provider.poll(providerJobId)).toEqual({ status: 'pending' });

    await new Promise((r) => setTimeout(r, STUB_JOB_DURATION_MS + 50));

    const result = await provider.poll(providerJobId);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.url).toMatch(/\.mp4$/);
      expect(result.costCents).toBe(25);
    }
  });

  it('surfaces retryable and non-retryable failures via markers', async () => {
    const provider = getVideoProvider('stub');

    const transient = await provider.generate({ ...videoInput, prompt: 'x [[stub:fail]]' });
    expect(await provider.poll(transient.providerJobId)).toMatchObject({
      status: 'failed',
      retryable: true,
    });

    const permanent = await provider.generate({
      ...videoInput,
      prompt: 'x [[stub:fail-permanent]]',
    });
    expect(await provider.poll(permanent.providerJobId)).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  it('treats an unknown job id as a non-retryable failure', async () => {
    expect(await getVideoProvider('stub').poll('stubvid_nope')).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });
});

describe('stub tts provider', () => {
  it('returns real audio bytes and a measured duration', async () => {
    const provider = getTtsProvider('stub');
    const { audio, durationSeconds } = await provider.synthesize({
      text: 'You told me he was dead.',
      voiceId: 'stub-voice-lead-f',
    });

    expect(audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(audio.byteLength).toBeGreaterThan(44);
    expect(durationSeconds).toBeGreaterThan(0);
  });

  it('estimates cost from text length and lists voices', async () => {
    const provider = getTtsProvider('stub');
    expect(provider.estimateCostCents('a'.repeat(1000))).toBe(30);
    expect(provider.estimateCostCents('short')).toBe(1);

    const voices = await provider.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toHaveProperty('tags');
  });
});

describe('ffmpeg render provider is refused on Vercel', () => {
  /**
   * No ffmpeg binary in the runtime, and the job map is per-instance. Better to
   * fail when the provider is selected than after an episode has already paid
   * for its clips.
   */
  it('throws at selection, naming the provider to use instead', () => {
    process.env.VERCEL = '1';
    expect(() => getRenderProvider('ffmpeg')).toThrow(/shotstack/);
  });

  it('is fine anywhere else', () => {
    delete process.env.VERCEL;
    expect(getRenderProvider('ffmpeg').id).toBe('ffmpeg');
  });
});

describe('stub render provider', () => {
  it('prices from the timeline length and completes', async () => {
    const provider = getRenderProvider('stub');
    expect(provider.estimateCostCents(renderInput)).toBe(4);

    const { providerJobId } = await provider.render(renderInput);
    expect(await provider.poll(providerJobId)).toEqual({ status: 'pending' });

    await new Promise((r) => setTimeout(r, STUB_JOB_DURATION_MS + 50));
    const result = await provider.poll(providerJobId);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.meta).toMatchObject({ resolution: '1080x1920', clipCount: 2 });
    }
  });
});

describe('stub jobs survive across module instances', () => {
  /**
   * Inngest runs each step as a separate HTTP request, and Next's dev server
   * re-evaluates modules between requests. A stub that held its jobs in a
   * module-scope Map therefore answered every `poll` with "unknown job", and 18
   * of 20 shots failed on the first real run through the UI.
   *
   * Importing a fresh copy of the module simulates that boundary.
   */
  it('a poll from a fresh module instance resolves the job', async () => {
    const first = getVideoProvider('stub');
    const { providerJobId } = await first.generate(videoInput);

    // A brand-new module registry — nothing shared with the instance above.
    const fresh = await import(`@/lib/providers/stub/video?fresh=${Date.now()}`);
    const second = new fresh.StubVideoProvider();

    expect(await second.poll(providerJobId)).toEqual({ status: 'pending' });

    await new Promise((r) => setTimeout(r, STUB_JOB_DURATION_MS + 50));

    const result = await second.poll(providerJobId);
    expect(result.status, 'a different instance must resolve the same id').toBe('ready');
    if (result.status === 'ready') expect(result.costCents).toBe(25);
  });

  it('carries the failure marker across instances too', async () => {
    const { providerJobId } = await getVideoProvider('stub').generate({
      ...videoInput,
      prompt: 'x [[stub:fail-permanent]]',
    });

    const fresh = await import(`@/lib/providers/stub/video?fresh2=${Date.now()}`);
    expect(await new fresh.StubVideoProvider().poll(providerJobId)).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  it('still rejects an id that is not a real job handle', async () => {
    expect(await getVideoProvider('stub').poll('stubvid_not-base64!!')).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });
});
