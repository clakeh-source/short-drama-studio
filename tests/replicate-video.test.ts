import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVideoProvider } from '@/lib/providers';
import type { VideoGenInput } from '@/lib/providers';
import {
  clampToGrid,
  extractOutputUrl,
  ReplicateVideoProvider,
  supportedDurations,
} from '@/lib/providers/replicate/video';

const input: VideoGenInput = {
  prompt: 'close-up, a woman in a red coat turns to face the camera, rain-slick alley, night',
  negativePrompt: 'blurry, watermark, text',
  durationSeconds: 6,
  aspectRatio: '9:16',
};

const originalEnv = { ...process.env };

/** A `fetch` that answers each call in turn with the given JSON bodies. */
function mockFetch(...responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  });

  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  process.env.REPLICATE_API_TOKEN = 'r8_test';
  process.env.REPLICATE_VIDEO_MODEL = 'someowner/somevideomodel';
  delete process.env.REPLICATE_VIDEO_DURATIONS;
  delete process.env.REPLICATE_VIDEO_COST_CENTS_PER_SECOND;
  delete process.env.REPLICATE_VIDEO_EXTRA_INPUT;
  delete process.env.REPLICATE_VIDEO_IMAGE_INPUT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('replicate registration', () => {
  it('resolves from VIDEO_PROVIDER without needing credentials at construction', () => {
    // `pnpm build` must not require a Replicate token; the adapter reads env
    // only when a method actually runs.
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_VIDEO_MODEL;
    expect(getVideoProvider('replicate').id).toBe('replicate');
  });
});

describe('duration grid', () => {
  it('defaults to the common 5/10 grid and rounds up on a tie', () => {
    expect(supportedDurations()).toEqual([5, 10]);
    // 7.5 is equidistant: the longer clip wins, because it can be trimmed
    // whereas a short one leaves a gap.
    expect(clampToGrid(7.5, [5, 10])).toBe(10);
    expect(clampToGrid(6, [5, 10])).toBe(5);
  });

  it('reads a custom grid, sorted, from the env', () => {
    process.env.REPLICATE_VIDEO_DURATIONS = '8, 4,  6 ';
    expect(supportedDurations()).toEqual([4, 6, 8]);
    expect(new ReplicateVideoProvider().clampDuration(4.5)).toBe(4);
    // 7 sits exactly between 6 and 8, so the tie-break sends it up.
    expect(new ReplicateVideoProvider().clampDuration(7)).toBe(8);
  });

  it('rejects a grid with no usable numbers instead of silently defaulting', () => {
    process.env.REPLICATE_VIDEO_DURATIONS = 'five,ten';
    expect(() => supportedDurations()).toThrow(/REPLICATE_VIDEO_DURATIONS/);
  });
});

describe('cost', () => {
  it('prices the clamped duration, not the requested one', () => {
    const provider = new ReplicateVideoProvider();
    // 6s clamps down to 5s on the default grid, at the default 5¢/s.
    expect(provider.estimateCostCents(input)).toBe(25);
  });

  it('uses the model price when one is configured', () => {
    process.env.REPLICATE_VIDEO_COST_CENTS_PER_SECOND = '12.5';
    expect(new ReplicateVideoProvider().estimateCostCents(input)).toBe(63);
  });
});

describe('request shape', () => {
  it('posts a bare slug to the model endpoint with no version', () => {
    const { url, body } = new ReplicateVideoProvider().buildRequest(input);

    expect(url).toBe('https://api.replicate.com/v1/models/someowner/somevideomodel/predictions');
    expect(body).not.toHaveProperty('version');
    expect(body.input).toMatchObject({
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      aspect_ratio: '9:16',
      duration: 5,
    });
  });

  it('posts a pinned slug to the generic endpoint with the version split out', () => {
    process.env.REPLICATE_VIDEO_MODEL = 'someowner/somevideomodel:abc123';
    const { url, body } = new ReplicateVideoProvider().buildRequest(input);

    expect(url).toBe('https://api.replicate.com/v1/predictions');
    expect(body.version).toBe('abc123');
  });

  it('merges extra input beneath the canonical fields, never over them', () => {
    process.env.REPLICATE_VIDEO_EXTRA_INPUT = '{"resolution":"1080p","prompt":"hijacked"}';
    const { body } = new ReplicateVideoProvider().buildRequest(input);

    expect(body.input).toMatchObject({ resolution: '1080p', prompt: input.prompt });
  });

  it('puts a reference image in the field the model names', () => {
    process.env.REPLICATE_VIDEO_IMAGE_INPUT = 'start_image';
    const { body } = new ReplicateVideoProvider().buildRequest({
      ...input,
      referenceImageUrls: ['https://example.test/face.png'],
    });

    expect(body.input).toMatchObject({ start_image: 'https://example.test/face.png' });
  });

  it('sends the first of several reference stills, since the model takes one', () => {
    const { body } = new ReplicateVideoProvider().buildRequest({
      ...input,
      referenceImageUrls: ['https://example.test/a.png', 'https://example.test/b.png'],
    });

    expect(body.input).toMatchObject({ image: 'https://example.test/a.png' });
  });

  it('omits the image field entirely when there are no reference stills', () => {
    // The difference between an image-to-video call and a text-to-video one.
    const { body } = new ReplicateVideoProvider().buildRequest({ ...input, referenceImageUrls: [] });

    expect(body.input).not.toHaveProperty('image');
  });

  it('rejects malformed extra input rather than dropping it', () => {
    process.env.REPLICATE_VIDEO_EXTRA_INPUT = 'not json';
    expect(() => new ReplicateVideoProvider().buildRequest(input)).toThrow(/valid JSON/);

    process.env.REPLICATE_VIDEO_EXTRA_INPUT = '[1,2]';
    expect(() => new ReplicateVideoProvider().buildRequest(input)).toThrow(/JSON object/);
  });

  it('names the missing env var when it is not configured', async () => {
    delete process.env.REPLICATE_API_TOKEN;
    await expect(new ReplicateVideoProvider().generate(input)).rejects.toThrow(
      /REPLICATE_API_TOKEN/,
    );

    process.env.REPLICATE_API_TOKEN = 'r8_test';
    delete process.env.REPLICATE_VIDEO_MODEL;
    await expect(new ReplicateVideoProvider().generate(input)).rejects.toThrow(
      /REPLICATE_VIDEO_MODEL/,
    );
  });
});

describe('generate', () => {
  it('returns the prediction id and sends the bearer token', async () => {
    const calls = mockFetch({ body: { id: 'pred_1', status: 'starting' } });

    const { providerJobId } = await new ReplicateVideoProvider().generate(input);

    expect(providerJobId).toBe('pred_1');
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer r8_test' });
  });

  it('surfaces the API detail when the prediction is refused', async () => {
    mockFetch({ ok: false, status: 422, body: { detail: 'Invalid version' } });

    await expect(new ReplicateVideoProvider().generate(input)).rejects.toThrow(
      /422.*Invalid version/,
    );
  });

  /**
   * Pointing the adapter at a real account with no credit on it returned 402 —
   * a refusal that repeats identically, which the Inngest step was retrying
   * three more times before giving up.
   */
  it('marks an empty account or a bad key as non-retryable', async () => {
    for (const status of [401, 402, 404, 422]) {
      mockFetch({ ok: false, status, body: { detail: 'nope' } });
      await expect(new ReplicateVideoProvider().generate(input)).rejects.toMatchObject({
        name: 'ProviderRequestError',
        retryable: false,
        status,
      });
    }
  });

  it('still retries a rate limit or an outage at submit time', async () => {
    for (const status of [429, 500, 503]) {
      mockFetch({ ok: false, status, body: { detail: 'later' } });
      await expect(new ReplicateVideoProvider().generate(input)).rejects.toMatchObject({
        name: 'ProviderRequestError',
        retryable: true,
      });
    }
  });
});

describe('poll', () => {
  it('is pending while the prediction is starting or processing', async () => {
    mockFetch({ body: { id: 'pred_1', status: 'processing' } });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toEqual({ status: 'pending' });
  });

  it('reports the url and charges for the duration the prediction actually ran', async () => {
    mockFetch({
      body: {
        id: 'pred_1',
        status: 'succeeded',
        // The grid clamped 6s down to 5s at submit time; the charge follows what
        // the model rendered, not what the shot asked for.
        input: { duration: 5 },
        output: 'https://replicate.delivery/out.mp4',
      },
    });

    const result = await new ReplicateVideoProvider().poll('pred_1');

    expect(result).toMatchObject({
      status: 'ready',
      url: 'https://replicate.delivery/out.mp4',
      costCents: 25,
    });
  });

  it('treats a failed prediction as retryable and a canceled one as not', async () => {
    mockFetch({ body: { status: 'failed', error: 'CUDA OOM' } });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toEqual({
      status: 'failed',
      error: 'CUDA OOM',
      retryable: true,
    });

    mockFetch({ body: { status: 'canceled' } });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  it('retries a 5xx or a rate limit, but not a 4xx', async () => {
    mockFetch({ ok: false, status: 503, body: {} });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toMatchObject({ retryable: true });

    mockFetch({ ok: false, status: 429, body: {} });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toMatchObject({ retryable: true });

    mockFetch({ ok: false, status: 404, body: {} });
    expect(await new ReplicateVideoProvider().poll('pred_1')).toMatchObject({ retryable: false });
  });

  it('fails permanently when a "succeeded" prediction has no video in it', async () => {
    // A text or image model in REPLICATE_VIDEO_MODEL. Retrying cannot fix it.
    mockFetch({ body: { status: 'succeeded', output: 'a caption, not a url' } });

    expect(await new ReplicateVideoProvider().poll('pred_1')).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });
});

describe('output extraction', () => {
  it('handles the shapes different models return', () => {
    expect(extractOutputUrl('https://a.test/v.mp4')).toBe('https://a.test/v.mp4');
    // Models emitting several assets put the finished video last.
    expect(extractOutputUrl(['https://a.test/1.png', 'https://a.test/v.mp4'])).toBe(
      'https://a.test/v.mp4',
    );
    expect(extractOutputUrl({ video: 'https://a.test/v.mp4' })).toBe('https://a.test/v.mp4');
    expect(extractOutputUrl(null)).toBeNull();
    expect(extractOutputUrl([])).toBeNull();
    expect(extractOutputUrl('not a url')).toBeNull();
  });
});

/**
 * Misconfiguration is certain, not transient.
 *
 * The job in generate-shot-video only short-circuits on a non-retryable
 * `ProviderRequestError`; anything else falls through to Inngest's retry policy.
 * These used to be bare `Error`s, so an unset model slug spent four attempts per
 * shot — 48 across a twelve-shot episode — reaching the same certain failure,
 * and left the assets mid-flight rather than failed with the reason on them.
 */
describe('configuration errors are refusals, not faults', () => {
  const cases: Array<[string, () => void]> = [
    ['REPLICATE_API_TOKEN missing', () => delete process.env.REPLICATE_API_TOKEN],
    ['REPLICATE_VIDEO_MODEL missing', () => delete process.env.REPLICATE_VIDEO_MODEL],
    [
      'REPLICATE_VIDEO_EXTRA_INPUT not JSON',
      () => {
        process.env.REPLICATE_VIDEO_EXTRA_INPUT = '{nope';
      },
    ],
  ];

  for (const [name, break_] of cases) {
    it(`${name} fails non-retryably`, async () => {
      break_();
      const provider = new ReplicateVideoProvider();

      await expect(
        provider.generate({ prompt: 'x', durationSeconds: 5, aspectRatio: '9:16' }),
      ).rejects.toMatchObject({ name: 'ProviderRequestError', retryable: false });
    });
  }

  it('reports a bad duration grid non-retryably too', () => {
    process.env.REPLICATE_VIDEO_DURATIONS = 'five,ten';
    expect(() => supportedDurations()).toThrow(
      expect.objectContaining({ name: 'ProviderRequestError', retryable: false }),
    );
  });
});
