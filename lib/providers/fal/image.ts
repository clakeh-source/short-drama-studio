import { configurationError, isRetryableStatus, ProviderRequestError } from '../types';
import type { GeneratedImage, ImageGenInput, ImageProvider } from '../types';

/**
 * Text-to-image via fal.ai — the source of character reference stills.
 *
 * This is what makes "one prompt in" possible at all: Kling's image-to-video
 * conditions on photographs, and until now those had to be uploaded by hand. A
 * character's `appearance_prompt` is already a purely physical description
 * written to be reused verbatim, which is exactly the input a text-to-image
 * model wants, so the two fit together without a translation step.
 *
 * Uses fal's queue like the video adapter, but waits for the result inline:
 * images take seconds, so there is nothing to be gained from a durable
 * submit/poll split and a lot of machinery to be avoided.
 */

const QUEUE_BASE = 'https://queue.fal.run';

/**
 * Flux dev by default rather than schnell.
 *
 * Schnell is roughly eight times cheaper and it shows — these images decide what
 * a character looks like in every clip of the film, so they are the wrong place
 * to save a cent. Override for a cheap dry run.
 */
const DEFAULT_MODEL = 'fal-ai/flux/dev';

/**
 * The identity-preserving model, used when a reference face is supplied.
 *
 * PuLID-for-Flux by default: it takes the face from a reference image and
 * everything else — pose, framing, wardrobe, setting — from the prompt, which
 * is exactly the split a character's canonical set needs. InstantID and
 * IP-Adapter FaceID are the same shape and drop straight in here.
 *
 * A plain text-to-image model given this slug would ignore the reference and
 * silently produce drift, which is why `supportsIdentity` is declared rather
 * than assumed.
 */
const DEFAULT_IDENTITY_MODEL = 'fal-ai/flux-pulid';

/** Published Flux dev pricing, per image, in cents. */
const DEFAULT_CENTS_PER_IMAGE = 3;

/** Identity models run a face encoder on top; they are priced accordingly. */
const DEFAULT_IDENTITY_CENTS_PER_IMAGE = 5;

/** fal's queue polls fast for images; this ceiling is generous. */
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 180_000;

function key(): string {
  const value = process.env.FAL_KEY?.trim();
  if (!value) {
    throw configurationError(
      'FAL_KEY is not set. Set it, or use IMAGE_PROVIDER=stub for local development.',
    );
  }
  return value;
}

export function imageModel(): string {
  return process.env.FAL_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
}

export function identityModel(): string {
  return process.env.FAL_IMAGE_IDENTITY_MODEL?.trim() || DEFAULT_IDENTITY_MODEL;
}

/**
 * Models whose face capacity is known, so the setting cannot lie about them.
 *
 * These three are single-identity by construction: they encode one face and
 * condition on it. Configuring a capacity above what a model reads would make
 * `facesUsed` claim a two-hander was locked when the second character was still
 * drawn from the prompt — the precise failure the capacity number exists to
 * expose, reintroduced through its own setting.
 *
 * Matched loosely because fal slugs carry versions and variants.
 */
const KNOWN_CAPACITY: Array<{ pattern: RegExp; capacity: number }> = [
  { pattern: /pulid/i, capacity: 1 },
  { pattern: /instant-?id/i, capacity: 1 },
  { pattern: /ip-?adapter/i, capacity: 1 },
];

/** What the configured model is known to read, or null if it is not known. */
export function knownCapacityFor(model: string): number | null {
  return KNOWN_CAPACITY.find((entry) => entry.pattern.test(model))?.capacity ?? null;
}

/**
 * How many faces the configured identity model actually reads.
 *
 * The ordering of `identityImageUrls` exists so that raising this is the only
 * change needed to adopt a multi-identity model. But it is a *description* of
 * the model, not a request to it — so a value above what the model is known to
 * read is clamped, and said out loud. Setting 4 against PuLID does not give you
 * four faces; it gives you one face and a wrong number in the asset row.
 *
 * Unknown models are trusted, because refusing them would make every new model
 * unusable until this list learned about it.
 */
export function identityCapacity(): number {
  const raw = Number(process.env.FAL_IMAGE_IDENTITY_CAPACITY);
  const requested = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 4) : 1;

  const known = knownCapacityFor(identityModel());
  if (known !== null && requested > known) {
    console.warn(
      `[fal] FAL_IMAGE_IDENTITY_CAPACITY=${requested} but ${identityModel()} reads ${known} ` +
        `face. Using ${known}. Point FAL_IMAGE_IDENTITY_MODEL at a multi-identity model to ` +
        `condition on more than one character per shot.`,
    );
    return known;
  }

  return requested;
}

/** Which model a request goes to, decided solely by whether faces were given. */
export function modelFor(input: Pick<ImageGenInput, 'identityImageUrls'>): {
  model: string;
  identity: boolean;
  faces: string[];
} {
  const faces = (input.identityImageUrls ?? []).map((u) => u.trim()).filter(Boolean);
  const identity = faces.length > 0;

  return {
    model: identity ? identityModel() : imageModel(),
    identity,
    faces: faces.slice(0, identityCapacity()),
  };
}

function centsPerImage(identity: boolean): number {
  const raw = (
    identity ? process.env.FAL_IMAGE_IDENTITY_COST_CENTS : process.env.FAL_IMAGE_COST_CENTS
  )?.trim();

  if (!raw) return identity ? DEFAULT_IDENTITY_CENTS_PER_IMAGE : DEFAULT_CENTS_PER_IMAGE;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configurationError(
      `${identity ? 'FAL_IMAGE_IDENTITY_COST_CENTS' : 'FAL_IMAGE_COST_CENTS'}="${raw}" ` +
        `is not a non-negative number.`,
    );
  }
  return parsed;
}

/** The queue's status and result endpoints hang off the application id. */
export function applicationId(model: string): string {
  return model.split('/').slice(0, 2).join('/');
}

/** Flux takes named sizes rather than a ratio string. */
export function imageSize(aspectRatio: ImageGenInput['aspectRatio']): string {
  return aspectRatio === '9:16' ? 'portrait_16_9' : 'square_hd';
}

interface QueueSubmission {
  request_id?: string;
  detail?: unknown;
}

interface FluxResult {
  images?: Array<{ url?: string; content_type?: string }>;
  detail?: unknown;
}

export class FalImageProvider implements ImageProvider {
  readonly id = 'fal';
  readonly supportsIdentity = true;
  readonly identityCapacity = identityCapacity();

  estimateCostCents(input: ImageGenInput): number {
    return Math.ceil(input.count * centsPerImage(Boolean(input.identityImageUrls?.length)));
  }

  /** The outgoing request, built without sending it. Asserted in tests. */
  buildRequest(input: ImageGenInput): {
    url: string;
    model: string;
    identity: boolean;
    /** How many of the supplied faces this model will actually read. */
    facesUsed: number;
    body: Record<string, unknown>;
  } {
    const { model, identity, faces } = modelFor(input);

    return {
      url: `${QUEUE_BASE}/${model}`,
      model,
      identity,
      facesUsed: faces.length,
      body: {
        prompt: input.prompt,
        image_size: imageSize(input.aspectRatio),
        num_images: input.count,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        // Flux has no negative prompt; models that do read this field.
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
        /**
         * The faces to preserve. PuLID names the field `reference_image_url`;
         * InstantID and IP-Adapter FaceID call it `image_url`. Both are sent
         * because they are mutually exclusive in practice — a model reads the
         * one it knows and ignores the other — and getting the name wrong means
         * the reference is silently dropped, which is the failure this whole
         * path exists to prevent.
         *
         * `reference_image_urls` carries the whole set for multi-identity
         * models. Single-identity models ignore it and read the scalar.
         */
        ...(identity
          ? {
              reference_image_url: faces[0],
              image_url: faces[0],
              ...(faces.length > 1 ? { reference_image_urls: faces } : {}),
            }
          : {}),
      },
    };
  }

  async generate(
    input: ImageGenInput,
  ): Promise<{ images: GeneratedImage[]; costCents: number }> {
    const { url, model, identity, body } = this.buildRequest(input);
    const auth = { authorization: `Key ${key()}` };

    const submission = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const accepted = (await submission.json().catch(() => null)) as QueueSubmission | null;

    if (!submission.ok || !accepted?.request_id) {
      throw new ProviderRequestError(
        // Names the model, because the two paths use different ones and a 404
        // here otherwise gives no clue which slug is wrong.
        `fal refused the ${identity ? 'identity' : 'image'} request to ${model} ` +
          `(${submission.status}): ${describe(accepted?.detail) ?? 'no detail'}`,
        { retryable: isRetryableStatus(submission.status), status: submission.status },
      );
    }

    const app = applicationId(model);
    const started = Date.now();

    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const status = await fetch(
        `${QUEUE_BASE}/${app}/requests/${accepted.request_id}/status`,
        { headers: auth },
      );

      if (!status.ok) {
        throw new ProviderRequestError(
          `fal image status check failed (${status.status}).`,
          { retryable: isRetryableStatus(status.status), status: status.status },
        );
      }

      const { status: state } = (await status.json()) as { status?: string };
      if (state !== 'COMPLETED') continue;

      const resultResponse = await fetch(`${QUEUE_BASE}/${app}/requests/${accepted.request_id}`, {
        headers: auth,
      });
      const result = (await resultResponse.json().catch(() => null)) as FluxResult | null;

      if (!resultResponse.ok) {
        throw new ProviderRequestError(
          `fal returned no image result (${resultResponse.status}): ${
            describe(result?.detail) ?? 'no detail'
          }`,
          { retryable: isRetryableStatus(resultResponse.status), status: resultResponse.status },
        );
      }

      const images = (result?.images ?? [])
        .filter((image): image is { url: string; content_type?: string } => Boolean(image.url))
        .map((image) => ({
          url: image.url,
          // Flux returns JPEG unless asked otherwise; the bucket allows both.
          contentType: image.content_type ?? 'image/jpeg',
        }));

      if (images.length === 0) {
        throw new ProviderRequestError(
          'fal reported the image job complete but returned no images. Check that ' +
            'FAL_IMAGE_MODEL names a text-to-image model.',
          { retryable: false },
        );
      }

      return {
        images,
        costCents: Math.ceil(images.length * centsPerImage(Boolean(input.identityImageUrls?.length))),
      };
    }

    throw new ProviderRequestError(
      `fal did not finish the image job within ${POLL_TIMEOUT_MS / 1000}s.`,
      { retryable: true },
    );
  }
}

function describe(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (detail === null || detail === undefined) return null;
  try {
    return JSON.stringify(detail).slice(0, 300);
  } catch {
    return null;
  }
}
