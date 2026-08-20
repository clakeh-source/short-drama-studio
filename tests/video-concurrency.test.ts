import { describe, expect, it } from 'vitest';

/**
 * `VIDEO_CONCURRENCY` is read once at module load, because the Inngest
 * function's `concurrency` option is evaluated when the function is defined.
 * That makes it untestable from inside another suite — so this file gets its own
 * worker and sets the variable before the modules that read it exist.
 *
 * The imports below are **dynamic on purpose**. `import` statements are hoisted
 * and evaluated before any statement in the module body, so a plain
 * `process.env.X = …` at the top of the file runs *after* the module that reads
 * it has already been loaded — which is exactly how the first version of this
 * test failed, asserting 8 and getting 3.
 *
 * What is worth proving: the lever moves the cap *and* the time estimate, and it
 * does not move the cost. Someone raising it to go faster should not discover
 * they also changed what the run charges.
 */
process.env.VIDEO_CONCURRENCY = '8';
process.env.FAL_KLING_COST_CENTS_PER_SECOND = '9';
process.env.FAL_IMAGE_COST_CENTS = '3';

const { MAX_INFLIGHT_VIDEO_JOBS } = await import('@/lib/data/generation');
const { estimateRun } = await import('@/lib/runs/estimate');
const { FalImageProvider } = await import('@/lib/providers/fal/image');
const { FalVideoProvider } = await import('@/lib/providers/fal/video');
const { StubTtsProvider } = await import('@/lib/providers/stub/tts');

const providers = {
  video: new FalVideoProvider(),
  image: new FalImageProvider(),
  tts: new StubTtsProvider(),
};

describe('raising VIDEO_CONCURRENCY', () => {
  it('raises the in-flight cap', () => {
    expect(MAX_INFLIGHT_VIDEO_JOBS).toBe(8);
  });

  it('shortens the run without changing what it costs', () => {
    const estimate = estimateRun({ targetSeconds: 180, ...providers });

    // 36 clips eight at a time rather than three: five batches instead of
    // twelve. The clips themselves are identical, so the money is not.
    expect(estimate.concurrency).toBe(8);
    expect(estimate.minutes).toBeLessThan(20);
    expect(estimate.totalCents).toBe(1926);
    expect(estimate.shots.expected).toBe(36);
  });
});
