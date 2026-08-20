/**
 * Shared machinery for the stub adapters.
 *
 * The stubs exist so the whole pipeline — enqueue, poll, store, cost-log — can
 * be exercised end to end in development and CI without spending money. They
 * deliberately mimic real provider behaviour: an async job handle, a polling
 * lifecycle that is `pending` before it is `ready`, and both retryable and
 * non-retryable failures.
 */

/**
 * Stub timings.
 *
 * The defaults imitate a real provider — a couple of seconds to accept a job, a
 * few more before it is ready — which is what makes the stubs useful for
 * exercising the polling, concurrency and admission logic during development.
 *
 * They are overridable because that realism is dead weight in the end-to-end
 * suite: seven shots spent about a minute of a three-minute budget waiting on
 * latency that exists only to be pretended. Turning it down changes how long the
 * fake provider takes, not which code paths run — every submit, sleep, poll,
 * claim and reconcile happens exactly as before.
 */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Every stub call takes this long, per the Phase 0 spec. */
export const STUB_LATENCY_MS = envMs('STUB_LATENCY_MS', 2_000);

/** How long a stub job stays `pending` before `poll` reports it ready. */
export const STUB_JOB_DURATION_MS = envMs('STUB_JOB_DURATION_MS', 4_000);

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Failure injection. A prompt (or voice id, or render input) containing one of
 * these markers makes the stub fail — this is how Phase 3 proves the retry path
 * without a real provider outage.
 */
export const FAIL_MARKER = '[[stub:fail]]';
export const FAIL_PERMANENT_MARKER = '[[stub:fail-permanent]]';

/**
 * Makes the language-model stub answer with prose instead of JSON.
 *
 * A different failure from the two above, and one no amount of provider-level
 * retrying fixes: the call *succeeds*, is billed, and returns something that
 * will never satisfy the schema. It is the realistic bad day for a model asked
 * for structured output, and the only way to exercise the "reject, surface the
 * raw output, persist nothing" path without a real model having a bad day.
 */
export const MALFORMED_MARKER = '[[stub:malformed]]';

export type StubFailure = { error: string; retryable: boolean } | null;

export function failureFor(text: string): StubFailure {
  if (text.includes(FAIL_PERMANENT_MARKER)) {
    return { error: 'stub: permanent failure requested by marker', retryable: false };
  }
  if (text.includes(FAIL_MARKER)) {
    return { error: 'stub: transient failure requested by marker', retryable: true };
  }
  return null;
}

export interface StubJob {
  id: string;
  readyAt: number;
  url: string;
  costCents: number;
  failure: StubFailure;
  meta?: Record<string, unknown>;
}

/**
 * The job id *is* the job.
 *
 * This used to be a module-scope `Map`, which does not work: Inngest performs
 * each step as a separate HTTP request, and Next's dev server re-evaluates
 * modules between requests, so `poll` looked up an id that `generate` had
 * created in a different module instance and got "unknown job" every time. It
 * would also have broken across a server restart, which is precisely what
 * Phase 3 AC #2 asks us to survive.
 *
 * Encoding the state into the id makes the stub genuinely stateless: any process,
 * at any time, can answer a poll correctly. That is also how real providers
 * behave — the id is a handle they resolve on their side.
 */
interface EncodedJob {
  /** Epoch ms at which the job becomes ready. */
  r: number;
  url: string;
  c: number;
  /** Failure: 0 none, 1 retryable, 2 terminal. */
  f: 0 | 1 | 2;
  m?: Record<string, unknown>;
}

function encode(payload: EncodedJob): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(token: string): EncodedJob | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as EncodedJob;
    return typeof parsed?.r === 'number' && typeof parsed?.url === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function createJob(input: {
  prefix: string;
  failureSource: string;
  url: string;
  costCents: number;
  meta?: Record<string, unknown>;
}): StubJob {
  const failure = failureFor(input.failureSource);

  const payload: EncodedJob = {
    r: Date.now() + STUB_JOB_DURATION_MS,
    url: input.url,
    c: input.costCents,
    f: failure ? (failure.retryable ? 1 : 2) : 0,
    ...(input.meta ? { m: input.meta } : {}),
  };

  return {
    id: `${input.prefix}_${encode(payload)}`,
    readyAt: payload.r,
    url: input.url,
    costCents: input.costCents,
    failure,
    ...(input.meta ? { meta: input.meta } : {}),
  };
}

export function getJob(id: string): StubJob | undefined {
  const token = id.slice(id.indexOf('_') + 1);
  const payload = decode(token);
  if (!payload) return undefined;

  return {
    id,
    readyAt: payload.r,
    url: payload.url,
    costCents: payload.c,
    failure:
      payload.f === 1
        ? { error: 'stub: transient failure requested by marker', retryable: true }
        : payload.f === 2
          ? { error: 'stub: permanent failure requested by marker', retryable: false }
          : null,
    ...(payload.m ? { meta: payload.m } : {}),
  };
}

/**
 * No-op, kept so existing tests read naturally. There is no longer any state to
 * clear — which is the point.
 */
export function clearStubJobs(): void {}

export function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}
