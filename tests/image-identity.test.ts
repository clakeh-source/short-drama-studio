import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FalImageProvider,
  identityModel,
  imageModel,
  modelFor,
} from '@/lib/providers/fal/image';
import { StubImageProvider } from '@/lib/providers/stub/image';
import type { ImageGenInput } from '@/lib/providers';

/**
 * Identity-preserving character stills.
 *
 * The thing worth guarding is not that a reference *can* be sent — it is that a
 * reference sent to the wrong model, or under the wrong field name, is
 * **silently ignored**. The images still come back, the set still looks
 * plausible in a thumbnail strip, and the drift only shows up thirty clips
 * later. So these assert the request body and the model choice, not just that a
 * call succeeded.
 */

const base: ImageGenInput = {
  prompt: 'East Asian woman in her early thirties, sharp jaw, olive canvas jacket',
  count: 1,
  aspectRatio: '9:16',
};

const FACE = 'https://storage.test/mei/hero.png';
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FAL_KEY = 'fal-test-key';
  delete process.env.FAL_IMAGE_MODEL;
  delete process.env.FAL_IMAGE_IDENTITY_MODEL;
  delete process.env.FAL_IMAGE_COST_CENTS;
  delete process.env.FAL_IMAGE_IDENTITY_COST_CENTS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('choosing the model', () => {
  it('uses the plain text-to-image model with no reference face', () => {
    const request = new FalImageProvider().buildRequest(base);

    expect(request.identity).toBe(false);
    expect(request.model).toBe(imageModel());
    // Absent, not undefined: a model that validates its inputs refuses the
    // latter.
    expect(request.body).not.toHaveProperty('reference_image_url');
    expect(request.body).not.toHaveProperty('image_url');
  });

  it('switches to the identity model when a face is supplied', () => {
    const request = new FalImageProvider().buildRequest({ ...base, identityImageUrls: [FACE] });

    expect(request.identity).toBe(true);
    expect(request.model).toBe(identityModel());
    expect(request.model).not.toBe(imageModel());
  });

  it('sends the face under both field names the models use', () => {
    // PuLID calls it `reference_image_url`; InstantID and IP-Adapter FaceID call
    // it `image_url`. Getting the name wrong drops the reference in silence.
    const { body } = new FalImageProvider().buildRequest({ ...base, identityImageUrls: [FACE] });

    expect(body.reference_image_url).toBe(FACE);
    expect(body.image_url).toBe(FACE);
  });

  it('keeps the prompt, which is what still varies the pose', () => {
    // The face comes from the reference and everything else from the prompt —
    // if the prompt were dropped, every still would be the hero again.
    const { body } = new FalImageProvider().buildRequest({
      ...base,
      prompt: 'three-quarter view, turned away',
      identityImageUrls: [FACE],
    });

    expect(body.prompt).toBe('three-quarter view, turned away');
  });

  it('treats a blank reference as no reference', () => {
    expect(modelFor({ identityImageUrls: ['   '] }).identity).toBe(false);
    expect(modelFor({ identityImageUrls: undefined }).identity).toBe(false);
    expect(modelFor({ identityImageUrls: [FACE] }).identity).toBe(true);
  });

  it('honours a configured identity model', () => {
    process.env.FAL_IMAGE_IDENTITY_MODEL = 'fal-ai/instant-id';
    const request = new FalImageProvider().buildRequest({ ...base, identityImageUrls: [FACE] });
    expect(request.model).toBe('fal-ai/instant-id');
  });
});

describe('cost', () => {
  it('prices identity generation above plain generation', () => {
    const provider = new FalImageProvider();

    const plain = provider.estimateCostCents({ ...base, count: 3 });
    const identity = provider.estimateCostCents({ ...base, count: 3, identityImageUrls: [FACE] });

    // A face encoder on top of the base model is not free, and quoting the
    // cheaper number would under-report every cast the autorun draws.
    expect(identity).toBeGreaterThan(plain);
  });

  it('takes a configured identity rate', () => {
    process.env.FAL_IMAGE_IDENTITY_COST_CENTS = '9';
    expect(
      new FalImageProvider().estimateCostCents({ ...base, count: 2, identityImageUrls: [FACE] }),
    ).toBe(18);
  });

  it('refuses a nonsense rate rather than silently mispricing', () => {
    process.env.FAL_IMAGE_IDENTITY_COST_CENTS = 'free';
    expect(() =>
      new FalImageProvider().estimateCostCents({ ...base, identityImageUrls: [FACE] }),
    ).toThrow(/FAL_IMAGE_IDENTITY_COST_CENTS/);
  });
});

describe('capability', () => {
  it('is declared by every provider', () => {
    // Callers branch on this to degrade deliberately rather than passing a
    // reference into a model that ignores it.
    expect(new FalImageProvider().supportsIdentity).toBe(true);
    expect(new StubImageProvider().supportsIdentity).toBe(true);
  });
});

describe('the stub propagates identity', () => {
  it('gives images conditioned on the same face a shared channel', async () => {
    const provider = new StubImageProvider();

    const a = await provider.generate({ ...base, prompt: 'front view', identityImageUrls: [FACE] });
    const b = await provider.generate({ ...base, prompt: 'side view', identityImageUrls: [FACE] });

    // The stub derives one channel from the reference and the rest from the
    // prompt, so "same person, different pose" is observable without a real
    // model. Without this the whole path would be uncheckable until it was
    // pointed at fal.
    expect(channel(a.images[0]!.url, 0)).toBe(channel(b.images[0]!.url, 0));
    expect(a.images[0]!.url).not.toBe(b.images[0]!.url);
  });

  it('gives images of different faces different channels', async () => {
    const provider = new StubImageProvider();

    const mei = await provider.generate({ ...base, identityImageUrls: [FACE] });
    const daniel = await provider.generate({
      ...base,
      identityImageUrls: ['https://storage.test/daniel/hero.png'],
    });

    expect(channel(mei.images[0]!.url, 0)).not.toBe(channel(daniel.images[0]!.url, 0));
  });

  it('falls back to the prompt when no face is given', async () => {
    const provider = new StubImageProvider();

    const a = await provider.generate({ ...base, prompt: 'front view' });
    const b = await provider.generate({ ...base, prompt: 'side view' });

    // Two prompts, two unrelated images — which is exactly the drift that
    // identity conditioning removes.
    expect(channel(a.images[0]!.url, 0)).not.toBe(channel(b.images[0]!.url, 0));
  });
});

/** Reads one RGB byte out of the stub's 1x1 data-URL PNG. */
function channel(dataUrl: string, index: 0 | 1 | 2): number {
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  // IDAT payload sits after the fixed-size signature, IHDR and zlib header.
  const idat = png.indexOf(Buffer.from('IDAT', 'ascii'));
  return png[idat + 4 + 7 + 1 + index]!;
}
