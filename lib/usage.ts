import 'server-only';

import { and, eq, gte, sql } from 'drizzle-orm';
import { withUserDb, type Transaction } from '@/lib/db';
import { usageLog } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { log } from '@/lib/log';

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecordUsageInput {
  userId: string;
  seriesId?: string | null;
  episodeId?: string | null;
  provider: string;
  operation: string;
  costCents: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /**
   * Makes this charge recordable at most once. Supply one wherever the caller
   * may be re-executed — every provider charge inside an Inngest step — keyed on
   * whatever identifies the individual chargeable act, typically
   * `<operation>:<shotId>:<attempt>`.
   */
  idempotencyKey?: string;
}

/**
 * One row per provider call. Every LLM call in /lib/ai routes through here, so
 * `usage_log` is the single source of truth for spend and the thing the Phase 5
 * dashboard reconciles against.
 *
 * Callers that can be re-executed must pass an `idempotencyKey`. Without one,
 * this is an unconditional insert, and re-running a step charges the user twice:
 * a restart mid-generation recorded 21 rows for 20 clips before that existed.
 *
 * Returns whether a row was written, so a duplicate is visible in the logs as a
 * suppression rather than silently looking like a second charge.
 */
export async function recordUsage(input: RecordUsageInput, tx?: Transaction): Promise<boolean> {
  const values = {
    userId: input.userId,
    seriesId: input.seriesId ?? null,
    episodeId: input.episodeId ?? null,
    provider: input.provider,
    operation: input.operation,
    costCents: Math.max(0, Math.round(input.costCents)),
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };

  const insert = (t: Transaction) =>
    input.idempotencyKey
      ? t
          .insert(usageLog)
          .values(values)
          .onConflictDoNothing({ target: usageLog.idempotencyKey })
          .returning({ id: usageLog.id })
      : t.insert(usageLog).values(values).returning({ id: usageLog.id });

  const rows = tx ? await insert(tx) : await withUserDb(input.userId, insert);
  const recorded = rows.length > 0;

  log.info(recorded ? 'usage recorded' : 'usage already recorded, not charging again', {
    userId: input.userId,
    seriesId: input.seriesId ?? undefined,
    episodeId: input.episodeId ?? undefined,
    provider: input.provider,
    operation: input.operation,
    costCents: recorded ? values.costCents : 0,
    tokensIn: values.tokensIn ?? undefined,
    tokensOut: values.tokensOut ?? undefined,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  return recorded;
}

export interface SpendSummary {
  spentCents: number;
  capCents: number;
  /** True once the cap is reached; generation endpoints refuse past this. */
  overCap: boolean;
  /** Set when the figure could not be read — the UI shows it as unknown. */
  unavailable?: boolean;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Total spend for the current calendar month, in cents. Read through the
 * user-scoped connection so RLS is the thing enforcing the boundary — not a
 * WHERE clause we could forget.
 */
export async function getMonthlySpendCents(userId: string): Promise<number> {
  return withUserDb(userId, async (tx) => {
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int` })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, startOfMonth())));

    return row?.total ?? 0;
  });
}

/** Never throws: a database hiccup must not take down the app shell. */
export async function getSpendSummary(userId: string): Promise<SpendSummary> {
  const capCents = env().MAX_MONTHLY_SPEND_CENTS;

  try {
    const spentCents = await getMonthlySpendCents(userId);
    return { spentCents, capCents, overCap: spentCents >= capCents };
  } catch (error) {
    log.warn('spend summary unavailable', {
      operation: 'usage.summary',
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { spentCents: 0, capCents, overCap: false, unavailable: true };
  }
}
