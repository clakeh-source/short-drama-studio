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

/** Published Flux dev pricing, per image, in cents. */
const DEFAULT_CENTS_PER_IMAGE = 3;

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

function centsPerImage(): number {
  const raw = process.env.FAL_IMAGE_COST_CENTS?.trim();
  if (!raw) return DEFAULT_CENTS_PER_IMAGE;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configurationError(`FAL_IMAGE_COST_CENTS="${raw}" is not a non-negative number.`);
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

  estimateCostCents(input: ImageGenInput): number {
    return Math.ceil(input.count * centsPerImage());
  }

  /** The outgoing request, built without sending it. Asserted in tests. */
  buildRequest(input: ImageGenInput): { url: string; model: string; body: Record<string, unknown> } {
    const model = imageModel();

    return {
      url: `${QUEUE_BASE}/${model}`,
      model,
      body: {
        prompt: input.prompt,
        image_size: imageSize(input.aspectRatio),
        num_images: input.count,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        // Flux has no negative prompt; models that do read this field.
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      },
    };
  }

  async generate(
    input: ImageGenInput,
  ): Promise<{ images: GeneratedImage[]; costCents: number }> {
    const { url, model, body } = this.buildRequest(input);
    const auth = { authorization: `Key ${key()}` };

    const submission = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const accepted = (await submission.json().catch(() => null)) as QueueSubmission | null;

    if (!submission.ok || !accepted?.request_id) {
      throw new ProviderRequestError(
        `fal refused the image request (${submission.status}): ${
          describe(accepted?.detail) ?? 'no detail'
        }`,
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

      return { images, costCents: Math.ceil(images.length * centsPerImage()) };
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
