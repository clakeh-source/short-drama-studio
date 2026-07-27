import { configurationError, isRetryableStatus, ProviderRequestError } from '../types';
import type { ProviderResult, VideoGenInput, VideoProvider } from '../types';

/**
 * Replicate video adapter.
 *
 * Replicate is a model host, not a model: `REPLICATE_VIDEO_MODEL` picks which
 * one runs. That is the whole reason this adapter is configured rather than
 * hard-coded — the duration grid, the price and the input field names all
 * belong to the model, not to Replicate, and they differ between them. A
 * version-pinned slug (`owner/name:version`) posts to `/v1/predictions` with a
 * `version`; a bare `owner/name` posts to the model's own predictions endpoint
 * and runs whatever version is current.
 *
 * The prediction lifecycle — POST returns an id, GET polls it — is the same
 * submit/poll shape `VideoProvider` already describes, so nothing outside this
 * file changes. Webhooks would be fewer requests, but polling is what the
 * durable job in `lib/inngest/functions/generate-shot-video.ts` is built around
 * and it needs no publicly reachable callback URL in development.
 */

const API_BASE = 'https://api.replicate.com/v1';

/**
 * Fallback duration grid. Most hosted video models accept only 5 or 10 seconds;
 * override with `REPLICATE_VIDEO_DURATIONS` for one that does not. The
 * storyboard plans against whatever this returns, so a wrong grid shows up as
 * shots that are the wrong length rather than as a generation-time error.
 */
const DEFAULT_DURATIONS = [5, 10];

/** Fallback price. Matches the stub, so switching provider does not move the
 *  cost panel until someone sets the real number for their model. */
const DEFAULT_CENTS_PER_SECOND = 5;

function token(): string {
  const value = process.env.REPLICATE_API_TOKEN;
  if (!value) {
    throw configurationError(
      'REPLICATE_API_TOKEN is not set. Set it, or use VIDEO_PROVIDER=stub for local development.',
    );
  }
  return value;
}

function modelSlug(): string {
  const value = process.env.REPLICATE_VIDEO_MODEL?.trim();
  if (!value) {
    throw configurationError(
      'REPLICATE_VIDEO_MODEL is not set. Give it a model slug, e.g. owner/name or owner/name:version.',
    );
  }
  return value;
}

/** Parsed once per call rather than cached, so a test can change the env. */
export function supportedDurations(): number[] {
  const raw = process.env.REPLICATE_VIDEO_DURATIONS?.trim();
  if (!raw) return DEFAULT_DURATIONS;

  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (parsed.length === 0) {
    throw configurationError(
      `REPLICATE_VIDEO_DURATIONS="${raw}" contains no positive numbers. Give it a comma-separated list, e.g. "5,10".`,
    );
  }
  return parsed.sort((a, b) => a - b);
}

function centsPerSecond(): number {
  const raw = process.env.REPLICATE_VIDEO_COST_CENTS_PER_SECOND?.trim();
  if (!raw) return DEFAULT_CENTS_PER_SECOND;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configurationError(
      `REPLICATE_VIDEO_COST_CENTS_PER_SECOND="${raw}" is not a non-negative number.`,
    );
  }
  return parsed;
}

/**
 * Model-specific inputs that have no place on `VideoGenInput` — resolution,
 * a motion strength, a model's own quality flag. Merged under the canonical
 * fields so a typo here cannot silently drop the prompt.
 */
function extraInput(): Record<string, unknown> {
  const raw = process.env.REPLICATE_VIDEO_EXTRA_INPUT?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError('REPLICATE_VIDEO_EXTRA_INPUT is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw configurationError('REPLICATE_VIDEO_EXTRA_INPUT must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Nearest supported duration, rounding *up* on a tie — the same rule the stub
 * uses, and for the same reason: an over-long clip is trimmed on the timeline,
 * a short one leaves a gap in the episode.
 */
export function clampToGrid(seconds: number, grid: number[]): number {
  return grid.reduce((best, candidate) =>
    Math.abs(candidate - seconds) <= Math.abs(best - seconds) ? candidate : best,
  );
}

/**
 * Replicate outputs are per-model: a bare URL string, or an array of them for a
 * model that returns frames as well as video. Take the last string that looks
 * like a URL — models that emit several put the finished video last.
 */
export function extractOutputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output.startsWith('http') ? output : null;

  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const candidate = output[i];
      if (typeof candidate === 'string' && candidate.startsWith('http')) return candidate;
    }
    return null;
  }

  // Some models wrap it, e.g. { video: "https://..." }.
  if (typeof output === 'object' && output !== null) {
    for (const key of ['video', 'url', 'output']) {
      const candidate = (output as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.startsWith('http')) return candidate;
    }
  }
  return null;
}

interface Prediction {
  id?: string;
  status?: string;
  /** Echoed back on GET, which is how `poll` recovers the duration it charged for. */
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
  detail?: string;
}

export class ReplicateVideoProvider implements VideoProvider {
  readonly id = 'replicate';

  clampDuration(seconds: number): number {
    return clampToGrid(seconds, supportedDurations());
  }

  estimateCostCents(input: VideoGenInput): number {
    return Math.ceil(this.clampDuration(input.durationSeconds) * centsPerSecond());
  }

  /** The prediction body. Exported shape so it can be asserted without network. */
  buildRequest(input: VideoGenInput): { url: string; body: Record<string, unknown> } {
    const slug = modelSlug();
    const duration = this.clampDuration(input.durationSeconds);

    const modelInput: Record<string, unknown> = {
      ...extraInput(),
      prompt: input.prompt,
      duration,
      aspect_ratio: input.aspectRatio,
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.referenceImageUrl
        ? { [process.env.REPLICATE_VIDEO_IMAGE_INPUT?.trim() || 'image']: input.referenceImageUrl }
        : {}),
    };

    const [name, version] = slug.split(':');

    // A pinned version goes to the generic endpoint; a bare slug to the model's
    // own, which resolves the current version server-side.
    return version
      ? { url: `${API_BASE}/predictions`, body: { version, input: modelInput } }
      : { url: `${API_BASE}/models/${name}/predictions`, body: { input: modelInput } };
  }

  async generate(input: VideoGenInput): Promise<{ providerJobId: string }> {
    const { url, body } = this.buildRequest(input);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => null)) as Prediction | null;

    if (!response.ok || !payload?.id) {
      throw new ProviderRequestError(
        `Replicate refused the prediction (${response.status}): ${
          payload?.detail ?? payload?.error ?? 'no detail'
        }`,
        // An empty account or a bad model slug refuses identically every time;
        // only a rate limit or an outage is worth another attempt.
        { retryable: isRetryableStatus(response.status), status: response.status },
      );
    }

    return { providerJobId: payload.id };
  }

  async poll(providerJobId: string): Promise<ProviderResult> {
    const response = await fetch(`${API_BASE}/predictions/${providerJobId}`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    if (!response.ok) {
      return {
        status: 'failed',
        error: `Replicate status check failed (${response.status}).`,
        // Rate limits and outages are worth another go; a bad id or a revoked
        // token is not.
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    const payload = (await response.json()) as Prediction;
    const status = payload.status;

    if (status === 'succeeded') {
      const url = extractOutputUrl(payload.output);
      if (!url) {
        return {
          status: 'failed',
          // Retrying cannot conjure an output field the model does not emit —
          // this is a wrong-model configuration, and it needs a human.
          error:
            'Replicate reported success but returned no video URL. Check that REPLICATE_VIDEO_MODEL is a video model.',
          retryable: false,
        };
      }

      /**
       * Replicate does not report what a prediction cost, so the charge is
       * priced from the duration the prediction actually ran with — echoed back
       * in `input` — rather than from what the shot asked for. The two differ
       * whenever the grid clamped the request, and the model bills for what it
       * rendered. It is exact whenever REPLICATE_VIDEO_COST_CENTS_PER_SECOND
       * matches the model's published per-second price.
       */
      const billedSeconds =
        typeof payload.input?.duration === 'number'
          ? payload.input.duration
          : this.clampDuration(0);

      return {
        status: 'ready',
        url,
        costCents: Math.ceil(billedSeconds * centsPerSecond()),
        meta: {
          adapter: 'replicate',
          model: process.env.REPLICATE_VIDEO_MODEL ?? null,
          durationSeconds: billedSeconds,
        },
      };
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        error: payload.error ?? 'Replicate reported the prediction as failed.',
        retryable: true,
      };
    }

    if (status === 'canceled') {
      return { status: 'failed', error: 'The prediction was canceled.', retryable: false };
    }

    // starting | processing
    return { status: 'pending' };
  }
}
