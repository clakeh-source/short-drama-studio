import 'server-only';

import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { withUserDb } from '@/lib/db';
import { assets, episodes, series, usageLog } from '@/lib/db/schema';

/**
 * The usage dashboard's numbers.
 *
 * Every figure is aggregated in Postgres from `usage_log`, and the breakdowns are
 * returned alongside the grand total so the page can be checked against itself.
 * Phase 5 AC #2 requires the dashboard to reconcile *exactly* with `usage_log`
 * sums, which is only meaningful if the breakdowns and the total come from the
 * same rows — so they share one window and one filter.
 *
 * Read through `withUserDb`, so RLS scopes every query and none of them carries a
 * `user_id` predicate.
 */

/** Reporting window, in days back from now. */
export const USAGE_WINDOW_DAYS = 30;

export interface UsageBucket {
  key: string;
  costCents: number;
  calls: number;
}

export interface UsageDayBucket {
  /** `YYYY-MM-DD`, UTC. The day *is* the key, so there is no separate one. */
  day: string;
  costCents: number;
  calls: number;
}

export interface UsageReport {
  /** Grand total over the window — the figure every breakdown must sum to. */
  totalCents: number;
  totalCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Clips produced, counted from assets rather than the ledger. */
  clipCount: number;
  voiceCount: number;
  byDay: UsageDayBucket[];
  byProvider: UsageBucket[];
  bySeries: Array<UsageBucket & { seriesId: string | null }>;
  byOperation: UsageBucket[];
  windowDays: number;
  since: string;
}

function windowStart(): Date {
  return new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export async function loadUsageReport(userId: string): Promise<UsageReport> {
  const since = windowStart();

  return withUserDb(userId, async (tx) => {
    const inWindow = and(eq(usageLog.userId, userId), gte(usageLog.createdAt, since));

    const [totals] = await tx
      .select({
        totalCents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        totalCalls: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${usageLog.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${usageLog.tokensOut}), 0)::int`,
      })
      .from(usageLog)
      .where(inWindow);

    const byDay = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageLog.createdAt}), 'YYYY-MM-DD')`,
        costCents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageLog)
      .where(inWindow)
      .groupBy(sql`date_trunc('day', ${usageLog.createdAt})`)
      .orderBy(asc(sql`date_trunc('day', ${usageLog.createdAt})`));

    const byProvider = await tx
      .select({
        key: usageLog.provider,
        costCents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageLog)
      .where(inWindow)
      .groupBy(usageLog.provider)
      .orderBy(desc(sql`sum(${usageLog.costCents})`));

    const byOperation = await tx
      .select({
        key: usageLog.operation,
        costCents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageLog)
      .where(inWindow)
      .groupBy(usageLog.operation)
      .orderBy(desc(sql`sum(${usageLog.costCents})`));

    /**
     * Left join, not inner: `usage_log.series_id` is nullable and is set to NULL
     * when a series is deleted, so an inner join would silently drop that spend
     * and the breakdown would no longer add up to the total.
     */
    const bySeries = await tx
      .select({
        seriesId: usageLog.seriesId,
        key: sql<string>`coalesce(${series.title}, 'Deleted or unattributed')`,
        costCents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageLog)
      .leftJoin(series, eq(series.id, usageLog.seriesId))
      .where(inWindow)
      .groupBy(usageLog.seriesId, series.title)
      .orderBy(desc(sql`sum(${usageLog.costCents})`));

    // Counted from assets, not the ledger: "how many clips do I have" is a
    // different question from "how many times was I charged".
    const [produced] = await tx
      .select({
        clipCount: sql<number>`count(*) filter (where ${assets.kind} = 'video' and ${assets.status} = 'ready')::int`,
        voiceCount: sql<number>`count(*) filter (where ${assets.kind} = 'voice' and ${assets.status} = 'ready')::int`,
      })
      .from(assets)
      .innerJoin(episodes, eq(episodes.id, assets.episodeId))
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(eq(series.userId, userId));

    return {
      totalCents: totals?.totalCents ?? 0,
      totalCalls: totals?.totalCalls ?? 0,
      tokensIn: totals?.tokensIn ?? 0,
      tokensOut: totals?.tokensOut ?? 0,
      clipCount: produced?.clipCount ?? 0,
      voiceCount: produced?.voiceCount ?? 0,
      byDay,
      byProvider,
      byOperation,
      bySeries,
      windowDays: USAGE_WINDOW_DAYS,
      since: since.toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * RFC 4180 quoting: double the quotes, wrap anything containing a comma, quote
 * or newline. A series title is user-supplied text and will contain commas.
 *
 * Also guards against CSV injection — a leading `=`, `+`, `-` or `@` makes Excel
 * treat the cell as a formula, and series titles come from the user.
 */
export function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  // CRLF per RFC 4180, and a trailing newline so `wc -l` matches the row count.
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The full ledger for the window, one row per provider call. */
export async function loadUsageCsv(userId: string): Promise<string> {
  const since = windowStart();

  const rows = await withUserDb(userId, (tx) =>
    tx
      .select({
        createdAt: usageLog.createdAt,
        provider: usageLog.provider,
        operation: usageLog.operation,
        costCents: usageLog.costCents,
        tokensIn: usageLog.tokensIn,
        tokensOut: usageLog.tokensOut,
        seriesTitle: series.title,
        episodeNumber: episodes.number,
      })
      .from(usageLog)
      .leftJoin(series, eq(series.id, usageLog.seriesId))
      .leftJoin(episodes, eq(episodes.id, usageLog.episodeId))
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, since)))
      .orderBy(desc(usageLog.createdAt)),
  );

  return toCsv([
    ['timestamp_utc', 'series', 'episode', 'provider', 'operation', 'cost_cents', 'tokens_in', 'tokens_out'],
    ...rows.map((r) => [
      r.createdAt.toISOString(),
      r.seriesTitle ?? '',
      r.episodeNumber ?? '',
      r.provider,
      r.operation,
      r.costCents,
      r.tokensIn ?? '',
      r.tokensOut ?? '',
    ]),
  ]);
}
