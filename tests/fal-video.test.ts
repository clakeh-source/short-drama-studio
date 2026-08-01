import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationId,
  decodeJobId,
  encodeJobId,
  FalVideoProvider,
} from '@/lib/providers/fal/video';
import type { VideoGenInput } from '@/lib/providers';

/**
 * Phase 4 — the fal.ai Kling adapter.
 *
 * The load-bearing assertion here is AC #1: a shot whose characters have
 * canonical reference stills must produce an *image-to-video* call carrying
 * them. `buildRequest` exists so that is inspectable rather than taken on trust,
 * and these check the request body itself, not the code path that produces it.
 */

const base: VideoGenInput = {
  prompt: 'Mei stands at the shuttered ticket window as rain sheets down the glass.',
  durationSeconds: 5,
  aspectRatio: '9:16',
};

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FAL_KEY = 'fal-test-key';
  delete process.env.FAL_KLING_EXTRA_INPUT;
  delete process.env.FAL_KLING_COST_CENTS_PER_SECOND;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('choosing the model', () => {
  it('AC #1 — reference stills make it an image-to-video call that carries them', () => {
    const stills = [
      'https://storage.test/mei/0.png',
      'https://storage.test/mei/1.png',
      'https://storage.test/mei/2.png',
    ];

    const request = new FalVideoProvider().buildRequest({ ...base, referenceImageUrls: stills });

    expect(request.mode).toBe('image-to-video');
    expect(request.model).toBe('fal-ai/kling-video/v3/pro/image-to-video');
    expect(request.url).toBe(
      'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video',
    );
    // `start_image_url` is the field name fal's schema for this endpoint gives,
    // and the only required one. `image_url` — what this sent until it was
    // checked against the schema — is not a field on it at all, so every call
    // was malformed and nothing here could tell.
    expect(request.body.start_image_url).toBe(stills[0]);
    expect(request.body).not.toHaveProperty('image_url');
  });

  it('sends one start frame, not the whole set', () => {
    // The endpoint conditions on a single image. The rest of a character's
    // canonical set has a home — `elements[]` — and it is not a top-level
    // field, so sending one made the request look richer than it was.
    const stills = ['https://storage.test/mei/0.png', 'https://storage.test/mei/1.png'];
    const { body } = new FalVideoProvider().buildRequest({ ...base, referenceImageUrls: stills });

    expect(body.start_image_url).toBe(stills[0]);
    expect(body).not.toHaveProperty('reference_image_urls');
  });

  it('falls back to text-to-video when there are no stills', () => {
    const request = new FalVideoProvider().buildRequest(base);

    expect(request.mode).toBe('text-to-video');
    expect(request.model).toBe('fal-ai/kling-video/v3/pro/text-to-video');
    // Not "start_image_url: undefined" — the field must be absent, or a model
    // that validates its inputs will refuse the request.
    expect(request.body).not.toHaveProperty('start_image_url');
    expect(request.body).not.toHaveProperty('image_url');
  });

  it('treats an empty or blank set as no set at all', () => {
    expect(new FalVideoProvider().buildRequest({ ...base, referenceImageUrls: [] }).mode).toBe(
      'text-to-video',
    );
    // A blank string would otherwise flip the mode and then send nothing useful.
    expect(
      new FalVideoProvider().buildRequest({ ...base, referenceImageUrls: ['  '] }).mode,
    ).toBe('text-to-video');
  });

  it('honours the configured model ids', () => {
    process.env.FAL_KLING_IMAGE_TO_VIDEO_MODEL = 'fal-ai/kling-video/v9/i2v';
    const request = new FalVideoProvider().buildRequest({
      ...base,
      referenceImageUrls: ['https://storage.test/a.png'],
    });
    expect(request.model).toBe('fal-ai/kling-video/v9/i2v');
  });
});

describe('elements — several faces in one clip', () => {
  const cast = [
    { name: 'Mei Lin', urls: ['https://storage.test/mei/0.png', 'https://storage.test/mei/1.png'] },
    { name: 'Daniel Voss', urls: ['https://storage.test/dan/0.png'] },
  ];

  it('sends the cast grouped, alongside the start frame', () => {
    const { body, elementsUsed } = new FalVideoProvider().buildRequest({
      ...base,
      prompt: 'Mei Lin and Daniel Voss face each other across the barrier.',
      referenceImageUrls: ['https://storage.test/keyframe.png'],
      castReferences: cast,
    });

    // The two answer different questions and both are sent: the start frame
    // says where this is and how it is framed, the elements say who is in it.
    expect(body.start_image_url).toBe('https://storage.test/keyframe.png');
    expect(elementsUsed).toBe(2);
    expect(body.elements).toEqual([
      {
        frontal_image_url: 'https://storage.test/mei/0.png',
        reference_image_urls: ['https://storage.test/mei/1.png'],
      },
      { frontal_image_url: 'https://storage.test/dan/0.png' },
    ]);
  });

  it('rewrites the prompt to point at them', () => {
    const { body } = new FalVideoProvider().buildRequest({
      ...base,
      prompt: 'Mei Lin and Daniel Voss face each other across the barrier.',
      referenceImageUrls: ['https://storage.test/keyframe.png'],
      castReferences: cast,
    });

    // Kling matches elements to the prompt by position, not by name. An
    // unrewritten prompt sends the faces and never refers to them.
    expect(body.prompt).toBe('@Element1 and @Element2 face each other across the barrier.');
  });

  it('leaves the prompt alone when there is no cast', () => {
    const { body, elementsUsed } = new FalVideoProvider().buildRequest({
      ...base,
      referenceImageUrls: ['https://storage.test/keyframe.png'],
    });

    expect(body.prompt).toBe(base.prompt);
    expect(body).not.toHaveProperty('elements');
    expect(elementsUsed).toBe(0);
  });

  it('sends no elements on a text-to-video call', () => {
    // `elements` is not a field on the text-to-video endpoint, and a shot with
    // no stills has no cast to hold in the first place.
    const { body, mode, elementsUsed } = new FalVideoProvider().buildRequest({
      ...base,
      castReferences: cast,
    });

    expect(mode).toBe('text-to-video');
    expect(body).not.toHaveProperty('elements');
    expect(body.prompt).toBe(base.prompt);
    expect(elementsUsed).toBe(0);
  });

  it('reports the cast it had to introduce', () => {
    const { introduced, body } = new FalVideoProvider().buildRequest({
      ...base,
      prompt: 'The ferryman waves the last passenger aboard.',
      referenceImageUrls: ['https://storage.test/keyframe.png'],
      castReferences: [{ name: 'Old Wen', urls: ['https://storage.test/wen.png'] }],
    });

    // Worth surfacing: a shot whose prompt never names its own cast is usually
    // a storyboard that drifted from the bible, and it degrades quietly.
    expect(introduced).toEqual(['Old Wen']);
    expect(body.prompt).toContain('@Element1 is Old Wen.');
  });
});

describe('the request body', () => {
  it('sends the duration as a string on Kling’s grid', () => {
    const { body } = new FalVideoProvider().buildRequest({ ...base, durationSeconds: 7 });
    // Kling renders 5s or 10s and takes the value as a string enum.
    expect(body.duration).toBe('5');
    expect(typeof body.duration).toBe('string');
  });

  it('carries the negative prompt and aspect ratio', () => {
    const { body } = new FalVideoProvider().buildRequest({
      ...base,
      negativePrompt: 'text, watermark',
    });
    expect(body).toMatchObject({ negative_prompt: 'text, watermark', aspect_ratio: '9:16' });
  });

  it('merges extra input beneath the canonical fields', () => {
    process.env.FAL_KLING_EXTRA_INPUT = JSON.stringify({ cfg_scale: 0.5, prompt: 'hijacked' });

    const { body } = new FalVideoProvider().buildRequest(base);

    expect(body.cfg_scale).toBe(0.5);
    // A typo in the extra input must not be able to replace the prompt.
    expect(body.prompt).toBe(base.prompt);
  });

  it('refuses malformed extra input rather than dropping it', () => {
    process.env.FAL_KLING_EXTRA_INPUT = 'not json';
    expect(() => new FalVideoProvider().buildRequest(base)).toThrow(/valid JSON/);

    process.env.FAL_KLING_EXTRA_INPUT = '[1,2]';
    expect(() => new FalVideoProvider().buildRequest(base)).toThrow(/JSON object/);
  });
});

describe('duration and cost', () => {
  it('clamps to the 5/10 grid', () => {
    const provider = new FalVideoProvider();
    expect(provider.clampDuration(3)).toBe(5);
    expect(provider.clampDuration(6)).toBe(5);
    expect(provider.clampDuration(9)).toBe(10);
    // MAX_CLIP_SECONDS is 15 and Kling's real ceiling is 10 — a 15s shot is
    // legal to plan and renders as 10, rather than being refused.
    expect(provider.clampDuration(15)).toBe(10);
  });

  it('prices from the configured rate', () => {
    process.env.FAL_KLING_COST_CENTS_PER_SECOND = '9';
    expect(new FalVideoProvider().estimateCostCents({ ...base, durationSeconds: 10 })).toBe(90);
  });
});

describe('the job id', () => {
  it('round-trips the model, duration and request id', () => {
    const id = encodeJobId('fal-ai/kling-video/v3/pro/image-to-video', 10, 'req-123');
    expect(decodeJobId(id)).toEqual({
      model: 'fal-ai/kling-video/v3/pro/image-to-video',
      durationSeconds: 10,
      requestId: 'req-123',
    });
  });

  it('is all a restarted worker needs to finish a job it never started', () => {
    // AC #3 in miniature: nothing about an in-flight job lives in worker memory.
    const id = encodeJobId('fal-ai/kling-video/v3/pro/text-to-video', 5, 'req-abc');
    const decoded = decodeJobId(id);
    expect(applicationId(decoded.model)).toBe('fal-ai/kling-video');
    expect(decoded.requestId).toBe('req-abc');
  });

  it('polls the application id, not the full model path', () => {
    // fal's status endpoint hangs off the app, not the variant. Getting this
    // wrong 404s every poll of a job that is running perfectly well.
    expect(applicationId('fal-ai/kling-video/v3/pro/image-to-video')).toBe('fal-ai/kling-video');
  });
});

describe('failures', () => {
  it('names the missing setting when FAL_KEY is unset', async () => {
    delete process.env.FAL_KEY;
    await expect(new FalVideoProvider().generate(base)).rejects.toThrow(/FAL_KEY is not set/);
  });

  it('treats a refusal as non-retryable and an outage as retryable', async () => {
    const provider = new FalVideoProvider();

    for (const [status, retryable] of [
      [402, false],
      [401, false],
      [422, false],
      [429, true],
      [500, true],
    ] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ detail: 'nope' }), { status }),
      );

      // Four attempts against an empty account is four identical refusals; the
      // flag is what stops the worker paying for that.
      await expect(provider.generate(base)).rejects.toMatchObject({ retryable, status });
    }
  });

  it('reports a completed job with no video as a configuration problem', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await new FalVideoProvider().poll(encodeJobId('fal-ai/kling-video', 5, 'r'));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    // Retrying cannot conjure an output field the model does not emit.
    expect(result.status === 'failed' && result.error).toMatch(/no video URL/);
  });

  it('reports an unfinished job as pending, whatever the queue calls it', async () => {
    for (const status of ['IN_QUEUE', 'IN_PROGRESS', 'SOMETHING_NEW']) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status }), { status: 200 }),
      );
      const result = await new FalVideoProvider().poll(encodeJobId('fal-ai/kling-video', 5, 'r'));
      expect(result.status).toBe('pending');
    }
  });
});

describe('a completed job', () => {
  it('returns the video and prices it from the clip length in the job id', async () => {
    process.env.FAL_KLING_COST_CENTS_PER_SECOND = '9';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ video: { url: 'https://fal.test/out.mp4', file_size: 1234 }, seed: 7 }),
          { status: 200 },
        ),
      );

    const result = await new FalVideoProvider().poll(
      encodeJobId('fal-ai/kling-video/v3/pro/image-to-video', 10, 'req-9'),
    );

    expect(result).toMatchObject({
      status: 'ready',
      url: 'https://fal.test/out.mp4',
      // 10s at 9c — the length actually rendered, not the length requested.
      costCents: 90,
    });
    expect(result.status === 'ready' && result.meta).toMatchObject({
      adapter: 'fal',
      durationSeconds: 10,
      seed: 7,
    });
  });
});
