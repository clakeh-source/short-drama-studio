/**
 * The polling schedule for provider jobs.
 *
 * Pure, so the shape of the schedule is testable without running a job: hosted
 * video models take anywhere from 20 seconds to several minutes, so poll fast at
 * first and then settle, with a hard ceiling so a wedged job cannot sleep for
 * ever holding a concurrency slot.
 *
 * Spec: 5s, 10s, 20s, 30s, 30s… with a 15-minute ceiling.
 */

export const POLL_CEILING_MS = 15 * 60 * 1000;

const RAMP_MS = [5_000, 10_000, 20_000] as const;
const STEADY_MS = 30_000;

/** Delays *between* polls, in order. Cumulative total never exceeds the ceiling. */
export function pollSchedule(ceilingMs: number = POLL_CEILING_MS): number[] {
  const delays: number[] = [];
  let total = 0;

  for (const delay of RAMP_MS) {
    if (total + delay > ceilingMs) return delays;
    delays.push(delay);
    total += delay;
  }

  while (total + STEADY_MS <= ceilingMs) {
    delays.push(STEADY_MS);
    total += STEADY_MS;
  }

  return delays;
}

export function scheduleTotalMs(ceilingMs: number = POLL_CEILING_MS): number {
  return pollSchedule(ceilingMs).reduce((a, b) => a + b, 0);
}

/** Inngest's `step.sleep` takes a duration string. */
export function toSleepDuration(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
