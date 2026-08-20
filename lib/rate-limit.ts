import 'server-only';

import { lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { rateLimits } from '@/lib/db/schema';
import { log } from '@/lib/log';

/**
 * Per-user request limits on the routes that cost money or CPU.
 *
 * The spend cap bounds the *bill*; this bounds the *rate*. They are not the
 * same guard: a script loop that stops at the cap has still made a hundred
 * requests to get there, each one holding a connection and a provider slot, and
 * a user who has spent nothing this month is otherwise free to make all of them
 * at once.
 *
 * Fixed windows rather than a sliding log or token bucket. A fixed window can
 * let through up to 2× the limit across a boundary, which for "stop hammering
 * the model" is a rounding error, and it costs exactly one statement per
 * request instead of a row per request to reason about.
 *
 * Counters live in Postgres because the app is serverless: an in-process map is
 * per-instance, and instances multiply under precisely the load a limiter is
 * for. The table is written through the privileged handle only — see the RLS
 * note on `rateLimits`.
 */

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * The three shapes of expensive request. Routes pick one rather than inventing
 * numbers, so the limits can be reasoned about in one place.
 */
export const RATE_LIMITS = {
  /**
   * A model call. Generous next to what a person can actually read, tight next
   * to what a script can ask for.
   */
  model: { limit: 20, windowSeconds: 60 },
  /** Enqueuing provider work — generation, renders, auditions. */
  job: { limit: 30, windowSeconds: 60 },
  /** Uploads and parsing: bounded bytes, unbounded appetite. */
  upload: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over, for `Retry-After`. */
  retryAfterSeconds: number;
}

/** One in this many calls also prunes windows nobody can be inside any more. */
const SWEEP_ODDS = 100;

/**
 * Counts one request against `operation` for `userId` and says whether it may
 * proceed.
 *
 * Never throws. A limiter that takes the app down when its own table is
 * unreachable has done more damage than the traffic it was there to shape, so a
 * failure here is logged and allowed through.
 */
export async function consumeRateLimit(
  userId: string,
  operation: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartSeconds = nowSeconds - (nowSeconds % rule.windowSeconds);
  const retryAfterSeconds = windowStartSeconds + rule.windowSeconds - nowSeconds;
  const key = `${userId}:${operation}:${windowStartSeconds}`;

  try {
    const [row] = await db()
      .insert(rateLimits)
      .values({
        key,
        count: 1,
        windowStart: new Date(windowStartSeconds * 1000),
      })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });

    const count = row?.count ?? 1;

    if (Math.random() < 1 / SWEEP_ODDS) void sweep();

    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds,
    };
  } catch (error) {
    log.warn('rate limiter unavailable, allowing the request', {
      operation,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { allowed: true, remaining: rule.limit, retryAfterSeconds };
  }
}

/**
 * Drops windows that closed an hour ago. Opportunistic rather than scheduled:
 * the table only grows while requests arrive, so the requests themselves are a
 * perfectly good clock, and this way the app owes nothing to a cron that may or
 * may not exist wherever it is deployed.
 */
async function sweep(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    await db().delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
  } catch {
    // Housekeeping. If it fails, the next request tries again.
  }
}
