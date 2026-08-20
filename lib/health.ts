import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * The dependency checks behind /api/health.
 *
 * Kept out of the route so they are unit-testable and so nothing here depends on
 * the request. Every check answers the same question — can this process actually
 * reach the thing — and none of them throws: a health endpoint that 500s tells
 * you less than one that reports which dependency is down.
 */

export type CheckStatus = 'ok' | 'degraded' | 'down';

export interface DependencyCheck {
  status: CheckStatus;
  /** Round-trip time of the probe, when one was made. */
  latencyMs?: number;
  /** Present when the status is not `ok`. */
  error?: string;
  [key: string]: unknown;
}

export interface HealthReport {
  status: CheckStatus;
  checks: {
    database: DependencyCheck;
    queue: DependencyCheck;
  };
  checkedAt: string;
}

/** How long a probe may hang before it counts as down. */
const PROBE_TIMEOUT_MS = 2_000;

export async function checkDatabase(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await db().execute(sql`select 1`);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Inngest is this project's job queue, in the role BullMQ-on-Redis plays
 * elsewhere: durable event delivery, retries and concurrency limits.
 *
 * Locally that is the dev server on port 8288, which has a `/health` endpoint
 * worth probing. In production the queue is Inngest Cloud, reached by signing
 * key — there is no unauthenticated endpoint to ping, and burning a real API
 * call on every health check would be worse than useless. So the cloud branch
 * reports what is verifiable (the app is configured to reach it) and says so,
 * rather than claiming a connection it has not made.
 */
export async function checkQueue(): Promise<DependencyCheck> {
  let config;
  try {
    config = env();
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * `INNGEST_DEV` wins over the event key.
   *
   * The SDK honours it regardless of what else is set, so a key left in `.env`
   * while running locally does not mean the queue is Inngest Cloud. Reporting
   * `cloud` in that case is worse than saying nothing: it sends someone looking
   * at their cloud dashboard for a run that is executing on their own machine —
   * which is exactly what this endpoint did during the first end-to-end
   * verification.
   */
  const forcedDev = Boolean(process.env.INNGEST_DEV?.trim());

  if (config.INNGEST_EVENT_KEY && !forcedDev) {
    return {
      status: 'ok',
      mode: 'cloud',
      probed: false,
      detail: 'Event key configured. Inngest Cloud exposes no unauthenticated probe.',
    };
  }

  const start = Date.now();
  try {
    const response = await fetch(new URL('/health', config.INNGEST_DEV_URL), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        status: 'down',
        mode: 'dev',
        probed: true,
        latencyMs: Date.now() - start,
        error: `Inngest dev server returned ${response.status}.`,
      };
    }

    return {
      status: 'ok',
      mode: 'dev',
      probed: true,
      latencyMs: Date.now() - start,
      // Worth saying out loud: a key is present but not in use.
      ...(config.INNGEST_EVENT_KEY ? { note: 'INNGEST_DEV overrides INNGEST_EVENT_KEY.' } : {}),
    };
  } catch (error) {
    return {
      status: 'down',
      mode: 'dev',
      probed: true,
      latencyMs: Date.now() - start,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? `No response from ${config.INNGEST_DEV_URL} within ${PROBE_TIMEOUT_MS}ms. Is \`pnpm inngest:dev\` running?`
          : `Could not reach ${config.INNGEST_DEV_URL}. Is \`pnpm inngest:dev\` running?`,
    };
  }
}

/** The worst status wins: one dependency down makes the whole app unhealthy. */
export function rollUp(checks: DependencyCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}

export async function healthReport(): Promise<HealthReport> {
  // Probed together: the endpoint's latency should be the slowest dependency,
  // not the sum of all of them.
  const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);

  return {
    status: rollUp([database, queue]),
    checks: { database, queue },
    checkedAt: new Date().toISOString(),
  };
}
