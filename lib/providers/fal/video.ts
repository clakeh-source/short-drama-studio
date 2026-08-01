import { configurationError, isRetryableStatus, ProviderRequestError } from '../types';
import type { ProviderResult, VideoGenInput, VideoProvider } from '../types';
import { composeElements } from './elements';

/**
 * Kling video via fal.ai.
 *
 * fal exposes long-running models through a queue: POST the inputs and get a
 * `request_id` back immediately, then poll a status endpoint until it reports
 * COMPLETED and fetch the result. That is the same submit/poll shape
 * `VideoProvider` already describes, so nothing outside this file changes.
 *
 * Two models, one rule for choosing between them: a shot whose characters have
 * canonical reference stills goes to image-to-video, so the same faces come back
 * across shots; a shot with none goes to text-to-video. Nothing here invents a
 * reference — no stills means text-to-video, deliberately, because conditioning
 * on the wrong face is worse than conditioning on none.
 */

const QUEUE_BASE = 'https://queue.fal.run';

/**
 * Kling renders 5- or 10-second clips and nothing in between.
 *
 * This is the provider's real grid and it is *below* `MAX_CLIP_SECONDS` (15),
 * which is the breakdown's ceiling. A 15-second shot is legal to plan and will
 * render as 10 — the storyboard and breakdown both snap durations through
 * `clampDuration`, so the mismatch shows up as a shorter clip, never as a
 * rejected request.
 */
const SUPPORTED_DURATIONS = [5, 10];

/**
 * Published Kling v3 Pro pricing, in cents per second of output.
 *
 * Overridable because fal changes prices and a wrong number here silently
 * misreports the spend cap rather than failing loudly.
 */
const DEFAULT_CENTS_PER_SECOND = 9;

function key(): string {
  const value = process.env.FAL_KEY?.trim();
  if (!value) {
    throw configurationError(
      'FAL_KEY is not set. Set it, or use VIDEO_PROVIDER=stub for local development.',
    );
  }
  return value;
}

export function textToVideoModel(): string {
  return (
    process.env.FAL_KLING_TEXT_TO_VIDEO_MODEL?.trim() ||
    'fal-ai/kling-video/v3/pro/text-to-video'
  );
}

export function imageToVideoModel(): string {
  return (
    process.env.FAL_KLING_IMAGE_TO_VIDEO_MODEL?.trim() ||
    'fal-ai/kling-video/v3/pro/image-to-video'
  );
}

function centsPerSecond(): number {
  const raw = process.env.FAL_KLING_COST_CENTS_PER_SECOND?.trim();
  if (!raw) return DEFAULT_CENTS_PER_SECOND;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configurationError(
      `FAL_KLING_COST_CENTS_PER_SECOND="${raw}" is not a non-negative number.`,
    );
  }
  return parsed;
}

/**
 * Model inputs with no place on `VideoGenInput` — `cfg_scale`, a resolution, a
 * motion setting. Merged *under* the canonical fields so a typo here cannot
 * silently drop the prompt or the reference image.
 */
function extraInput(): Record<string, unknown> {
  const raw = process.env.FAL_KLING_EXTRA_INPUT?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError('FAL_KLING_EXTRA_INPUT is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw configurationError('FAL_KLING_EXTRA_INPUT must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The queue's status and result endpoints hang off the *application* id, not the
 * full model path: a job submitted to `fal-ai/kling-video/v3/pro/image-to-video`
 * is polled at `fal-ai/kling-video/requests/{id}/status`. Getting this wrong
 * gives a 404 on every poll of a job that is running perfectly well.
 */
export function applicationId(model: string): string {
  return model.split('/').slice(0, 2).join('/');
}

/**
 * `providerJobId` has to survive a process restart and still be enough to finish
 * the job on its own.
 *
 * fal's request id says nothing about which model produced it or how long the
 * clip is, and `poll` needs both — the first to find the status endpoint, the
 * second to price the charge, because fal reports no per-request cost. Rather
 * than keep that alongside the job in a table the worker would have to re-read
 * after a restart, it travels *in the id*. That is what makes polling stateless
 * and a resumed worker able to pick up a job it knows nothing else about.
 */
export function encodeJobId(model: string, durationSeconds: number, requestId: string): string {
  return `${model}#${durationSeconds}#${requestId}`;
}

export function decodeJobId(providerJobId: string): {
  model: string;
  durationSeconds: number;
  requestId: string;
} {
  const parts = providerJobId.split('#');

  if (parts.length === 3) {
    const duration = Number(parts[1]);
    return {
      model: parts[0]!,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 10,
      requestId: parts[2]!,
    };
  }

  // A bare id: not one this adapter minted. Poll it against the default model
  // and price it at the longest clip, so an unknown job is never under-charged.
  return { model: textToVideoModel(), durationSeconds: 10, requestId: providerJobId };
}

interface QueueSubmission {
  request_id?: string;
  detail?: unknown;
  error?: string;
}

interface QueueStatus {
  status?: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | string;
  queue_position?: number;
  error?: unknown;
}

interface KlingResult {
  video?: { url?: string; file_size?: number };
  /** fal echoes the seed it used; useful for reproducing a take. */
  seed?: number;
  detail?: unknown;
}

export class FalVideoProvider implements VideoProvider {
  readonly id = 'fal';

  clampDuration(seconds: number): number {
    return SUPPORTED_DURATIONS.reduce((best, candidate) =>
      Math.abs(candidate - seconds) <= Math.abs(best - seconds) ? candidate : best,
    );
  }

  estimateCostCents(input: VideoGenInput): number {
    return Math.ceil(this.clampDuration(input.durationSeconds) * centsPerSecond());
  }

  /**
   * The outgoing request, built without sending it.
   *
   * Separate from `generate` so the exact body — which model, which reference
   * stills — can be asserted in a test and logged in production. Phase 4 AC #1
   * asks for the image-to-video call to be *inspectable* rather than taken on
   * trust, and this is the seam that makes that possible.
   */
  buildRequest(input: VideoGenInput): {
    url: string;
    model: string;
    mode: 'image-to-video' | 'text-to-video';
    /** How many characters the clip is conditioned on by face, not by description. */
    elementsUsed: number;
    /** Cast whose names the prompt never used, so they had to be introduced. */
    introduced: string[];
    body: Record<string, unknown>;
  } {
    const stills = input.referenceImageUrls?.filter((url) => url.trim().length > 0) ?? [];
    const mode = stills.length > 0 ? 'image-to-video' : 'text-to-video';
    const model = mode === 'image-to-video' ? imageToVideoModel() : textToVideoModel();

    /**
     * Each character in the shot, held by their own stills.
     *
     * Only on the image-to-video endpoint: `elements` is not a field on
     * text-to-video, and a shot with no stills has no cast to hold anyway.
     * The start frame stays — it sets the location and the framing, which
     * elements say nothing about. The two answer different questions.
     */
    const cast =
      mode === 'image-to-video' ? composeElements(input.prompt, input.castReferences ?? []) : null;

    const body: Record<string, unknown> = {
      ...extraInput(),
      // Rewritten to point at the elements by position when there are any:
      // Kling reads `@Element1`, not "Mei".
      prompt: cast && cast.elements.length > 0 ? cast.prompt : input.prompt,
      // Kling takes the duration as a string enum, not a number.
      duration: String(this.clampDuration(input.durationSeconds)),
      aspect_ratio: input.aspectRatio,
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      /**
       * The start frame. `start_image_url` is the *only* required field on
       * Kling's image-to-video endpoint, per fal's OpenAPI schema for it.
       *
       * This was `image_url`, which that endpoint does not define — so every
       * image-to-video call this adapter has ever made was malformed. It has
       * never been caught because it has never been run against live fal, and
       * from the outside a rejected submission looks like any other provider
       * refusal.
       *
       * Only one image goes. The endpoint takes the rest of a character's
       * canonical set through `elements[]`, not through a top-level field —
       * `reference_image_urls` was being sent there and silently ignored. What
       * the shot conditioned on is recorded on the asset row either way
       * (`referenceImageCount`, `referenceCharacters`), so nothing is lost by
       * not sending a field the model never reads.
       */
      ...(mode === 'image-to-video' ? { start_image_url: stills[0] } : {}),
      ...(cast && cast.elements.length > 0 ? { elements: cast.elements } : {}),
    };

    return {
      url: `${QUEUE_BASE}/${model}`,
      model,
      mode,
      elementsUsed: cast?.elements.length ?? 0,
      introduced: cast?.introduced ?? [],
      body,
    };
  }

  async generate(input: VideoGenInput): Promise<{ providerJobId: string }> {
    const { url, model, body } = this.buildRequest(input);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Key ${key()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => null)) as QueueSubmission | null;

    if (!response.ok || !payload?.request_id) {
      throw new ProviderRequestError(
        `fal refused the request (${response.status}): ${
          describe(payload?.detail) ?? payload?.error ?? 'no detail'
        }`,
        // An empty account, a revoked key or a model that does not exist refuses
        // identically every time; only a rate limit or an outage is worth
        // another attempt.
        { retryable: isRetryableStatus(response.status), status: response.status },
      );
    }

    return {
      providerJobId: encodeJobId(
        model,
        this.clampDuration(input.durationSeconds),
        payload.request_id,
      ),
    };
  }

  async poll(providerJobId: string): Promise<ProviderResult> {
    const { model, durationSeconds, requestId } = decodeJobId(providerJobId);
    const app = applicationId(model);

    const statusResponse = await fetch(
      `${QUEUE_BASE}/${app}/requests/${requestId}/status`,
      { headers: { authorization: `Key ${key()}` } },
    );

    if (!statusResponse.ok) {
      return {
        status: 'failed',
        error: `fal status check failed (${statusResponse.status}).`,
        // Rate limits and outages are worth another go; a bad id or a revoked
        // key is not.
        retryable: isRetryableStatus(statusResponse.status),
      };
    }

    const status = (await statusResponse.json()) as QueueStatus;

    if (status.status !== 'COMPLETED') {
      // IN_QUEUE and IN_PROGRESS are both "not yet". Anything unrecognised is
      // treated the same way rather than guessed at: the poll loop has its own
      // ceiling, so an unknown state cannot hang for ever.
      return { status: 'pending' };
    }

    const resultResponse = await fetch(`${QUEUE_BASE}/${app}/requests/${requestId}`, {
      headers: { authorization: `Key ${key()}` },
    });

    const result = (await resultResponse.json().catch(() => null)) as KlingResult | null;

    if (!resultResponse.ok) {
      return {
        status: 'failed',
        error: `fal returned no result for a completed job (${resultResponse.status}): ${
          describe(result?.detail) ?? 'no detail'
        }`,
        retryable: isRetryableStatus(resultResponse.status),
      };
    }

    const url = result?.video?.url;
    if (!url) {
      return {
        status: 'failed',
        // Retrying cannot conjure a video field the model does not emit. This is
        // a wrong-model configuration and it needs a human.
        error:
          'fal reported the job complete but returned no video URL. Check that ' +
          'FAL_KLING_TEXT_TO_VIDEO_MODEL names a video model.',
        retryable: false,
      };
    }

    /**
     * fal does not report a per-request charge, so the cost is priced from the
     * clip length carried in the job id — what was actually rendered, not what
     * the shot asked for. Exact whenever FAL_KLING_COST_CENTS_PER_SECOND matches
     * Kling's published price.
     */
    return {
      status: 'ready',
      url,
      costCents: Math.ceil(durationSeconds * centsPerSecond()),
      meta: {
        adapter: 'fal',
        model,
        requestId,
        durationSeconds,
        ...(result?.seed !== undefined ? { seed: result.seed } : {}),
        ...(result?.video?.file_size !== undefined ? { bytes: result.video.file_size } : {}),
      },
    };
  }
}

/** fal's error `detail` is sometimes a string and sometimes a list of objects. */
function describe(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (detail === null || detail === undefined) return null;
  try {
    return JSON.stringify(detail).slice(0, 300);
  } catch {
    return null;
  }
}
