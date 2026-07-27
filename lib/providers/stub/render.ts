import type { ProviderResult, RenderInput, RenderProvider } from '../types';
import { appOrigin, createJob, delay, getJob, STUB_LATENCY_MS } from './support';

/** Cloud render APIs bill by output minute; ~$0.20/min at 1080p. */
const CENTS_PER_MINUTE = 20;

export function timelineSeconds(input: RenderInput): number {
  return input.clips.reduce((end, clip) => Math.max(end, clip.startAt + clip.durationSeconds), 0);
}

export class StubRenderProvider implements RenderProvider {
  readonly id = 'stub';

  estimateCostCents(input: RenderInput): number {
    return Math.max(1, Math.ceil((timelineSeconds(input) / 60) * CENTS_PER_MINUTE));
  }

  async render(input: RenderInput): Promise<{ providerJobId: string }> {
    await delay(STUB_LATENCY_MS);
    const duration = timelineSeconds(input);
    const job = createJob({
      prefix: 'stubrender',
      failureSource: input.captions.map((c) => c.text).join(' '),
      url: `${appOrigin()}/stub/episode.mp4`,
      costCents: this.estimateCostCents(input),
      meta: {
        durationSeconds: duration,
        resolution: input.resolution,
        clipCount: input.clips.length,
        captionCount: input.captions.length,
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
