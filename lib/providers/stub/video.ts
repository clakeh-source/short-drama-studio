import type { ProviderResult, VideoGenInput, VideoProvider } from '../types';
import { appOrigin, createJob, delay, getJob, STUB_LATENCY_MS } from './support';

/** Priced to resemble a mid-tier hosted video model: $0.05 per second. */
const CENTS_PER_SECOND = 5;

/** Most hosted video models only accept a handful of durations. */
const SUPPORTED_DURATIONS = [3, 4, 5, 6, 8] as const;

/**
 * Nearest supported duration, rounding *up* on a tie: an over-long clip can be
 * trimmed on the timeline, while a short one leaves a gap in the episode.
 */
export function clampDuration(seconds: number): number {
  return SUPPORTED_DURATIONS.reduce((best, candidate) =>
    Math.abs(candidate - seconds) <= Math.abs(best - seconds) ? candidate : best,
  );
}

export class StubVideoProvider implements VideoProvider {
  readonly id = 'stub';

  /**
   * Matches the fal adapter's ceiling, so a stub run exercises the same cast
   * arithmetic as a real one. Nothing here reads the faces — but a stub that
   * declared zero would make every local run look like a drifting one.
   */
  readonly castCapacity = 4;

  clampDuration(seconds: number): number {
    return clampDuration(seconds);
  }

  estimateCostCents(input: VideoGenInput): number {
    return clampDuration(input.durationSeconds) * CENTS_PER_SECOND;
  }

  async generate(input: VideoGenInput): Promise<{ providerJobId: string }> {
    await delay(STUB_LATENCY_MS);
    const job = createJob({
      prefix: 'stubvid',
      failureSource: `${input.prompt} ${input.negativePrompt ?? ''}`,
      url: `${appOrigin()}/stub/clip.mp4`,
      costCents: this.estimateCostCents(input),
      meta: {
        durationSeconds: clampDuration(input.durationSeconds),
        aspectRatio: input.aspectRatio,
        seed: input.seed ?? null,
      },
    });
    return { providerJobId: job.id };
  }

  async poll(providerJobId: string): Promise<ProviderResult> {
    const job = getJob(providerJobId);
    if (!job) {
      return { status: 'failed', error: `unknown job ${providerJobId}`, retryable: false };
    }
    if (job.failure) {
      return { status: 'failed', ...job.failure };
    }
    if (Date.now() < job.readyAt) {
      return { status: 'pending' };
    }
    return {
      status: 'ready',
      url: job.url,
      costCents: job.costCents,
      ...(job.meta ? { meta: job.meta } : {}),
    };
  }
}
