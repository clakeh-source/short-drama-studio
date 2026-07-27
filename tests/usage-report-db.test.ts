import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { episodes, series, usageLog } from '@/lib/db/schema';
import { loadUsageReport, loadUsageCsv, csvCell, toCsv } from '@/lib/data/usage-report';

/**
 * Phase 5 AC #2 — the dashboard's totals must reconcile *exactly* with
 * `usage_log`. Every breakdown is a separate `GROUP BY`, so any one of them can
 * drop or double-count rows independently: a `JOIN` that should have been a
 * `LEFT JOIN` silently loses the spend of a deleted series, and the page would
 * still look plausible.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

const userId = crypto.randomUUID();
const otherUserId = crypto.randomUUID();
let seriesA: string;
let seriesB: string;
let episodeA: string;

describe.skipIf(!hasDatabase).sequential('usage report', () => {
  beforeAll(async () => {
    const handle = db();

    const mkSeries = async (uid: string, title: string) => {
      const [row] = await handle
        .insert(series)
        .values({
          userId: uid,
          title,
          logline: 'A test series.',
          episodeTargetCount: 1,
          episodeTargetSeconds: 60,
        })
        .returning();
      return row!.id;
    };

    seriesA = await mkSeries(userId, 'Series A');
    seriesB = await mkSeries(userId, 'Series B, with a comma');
    const foreign = await mkSeries(otherUserId, 'Someone else');

    const [ep] = await handle
      .insert(episodes)
      .values({ seriesId: seriesA, number: 1, title: 'Night 1' })
      .returning();
    episodeA = ep!.id;

    await handle.insert(usageLog).values([
      { userId, seriesId: seriesA, episodeId: episodeA, provider: 'stub', operation: 'video.generate', costCents: 25 },
      { userId, seriesId: seriesA, episodeId: episodeA, provider: 'stub', operation: 'video.generate', costCents: 25 },
      { userId, seriesId: seriesA, episodeId: episodeA, provider: 'stub', operation: 'voice.synthesize', costCents: 3 },
      { userId, seriesId: seriesB, provider: 'anthropic', operation: 'script.generate', costCents: 11, tokensIn: 900, tokensOut: 1_400 },
      { userId, seriesId: seriesB, provider: 'anthropic', operation: 'bible.generate', costCents: 7, tokensIn: 400, tokensOut: 800 },
      // Spend whose series has gone: `series_id` is ON DELETE SET NULL, and this
      // row must still appear in the by-series breakdown or it stops adding up.
      { userId, seriesId: null, provider: 'shotstack', operation: 'render.episode', costCents: 20 },
      // Another user's spend — RLS must keep it out of every figure.
      { userId: otherUserId, seriesId: foreign, provider: 'stub', operation: 'video.generate', costCents: 999 },
    ]);
  });

  afterAll(async () => {
    await db().delete(usageLog).where(eq(usageLog.userId, userId));
    await db().delete(usageLog).where(eq(usageLog.userId, otherUserId));
    await db().delete(series).where(eq(series.userId, userId));
    await db().delete(series).where(eq(series.userId, otherUserId));
    await closeDb();
  });

  /** The unaggregated truth, straight from the table. */
  async function rawTotal(): Promise<{ cents: number; calls: number }> {
    const [row] = await db()
      .select({
        cents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(usageLog)
      .where(eq(usageLog.userId, userId));
    return row!;
  }

  it('the grand total equals the raw usage_log sum', async () => {
    const [report, raw] = await Promise.all([loadUsageReport(userId), rawTotal()]);
    expect(report.totalCents).toBe(raw.cents);
    expect(report.totalCalls).toBe(raw.calls);
    // 25+25+3+11+7+20, and nothing from the other user.
    expect(report.totalCents).toBe(91);
  });

  it('AC #2 — every breakdown sums to the grand total', async () => {
    const report = await loadUsageReport(userId);
    const sum = (buckets: ReadonlyArray<{ costCents: number }>) =>
      buckets.reduce((n, b) => n + b.costCents, 0);
    const calls = (buckets: ReadonlyArray<{ calls: number }>) =>
      buckets.reduce((n, b) => n + b.calls, 0);

    for (const [name, buckets] of [
      ['byDay', report.byDay],
      ['byProvider', report.byProvider],
      ['bySeries', report.bySeries],
      ['byOperation', report.byOperation],
    ] as const) {
      expect(sum(buckets), `${name} cost must reconcile`).toBe(report.totalCents);
      expect(calls(buckets), `${name} call count must reconcile`).toBe(report.totalCalls);
    }
  });

  it('keeps spend whose series was deleted in the by-series breakdown', async () => {
    const report = await loadUsageReport(userId);
    const orphan = report.bySeries.find((b) => b.seriesId === null);
    expect(orphan, 'unattributed spend must still be shown').toBeDefined();
    expect(orphan!.costCents).toBe(20);
  });

  it('excludes another user’s spend entirely', async () => {
    const report = await loadUsageReport(userId);
    expect(report.totalCents).toBe(91);
    expect(report.byProvider.map((b) => b.key)).not.toContain('runway');
    expect(report.bySeries.map((b) => b.key)).not.toContain('Someone else');
  });

  it('reports tokens summed across LLM calls only', async () => {
    const report = await loadUsageReport(userId);
    expect(report.tokensIn).toBe(1_300);
    expect(report.tokensOut).toBe(2_200);
  });

  it('groups providers and operations correctly', async () => {
    const report = await loadUsageReport(userId);
    const provider = Object.fromEntries(report.byProvider.map((b) => [b.key, b.costCents]));
    expect(provider.stub).toBe(53);
    expect(provider.anthropic).toBe(18);
    expect(provider.shotstack).toBe(20);

    const op = Object.fromEntries(report.byOperation.map((b) => [b.key, b.calls]));
    expect(op['video.generate']).toBe(2);
  });

  describe('CSV export', () => {
    it('has one data row per ledger row, plus a header', async () => {
      const csv = await loadUsageCsv(userId);
      const lines = csv.trimEnd().split('\r\n');
      const raw = await rawTotal();

      expect(lines[0]).toContain('timestamp_utc');
      expect(lines).toHaveLength(raw.calls + 1);
    });

    it('costs in the CSV sum to the dashboard total', async () => {
      const csv = await loadUsageCsv(userId);
      const [, ...dataLines] = csv.trimEnd().split('\r\n');

      // cost_cents is column index 5; none of the preceding cells contain commas
      // except the series title, which is quoted — so parse rather than split.
      const total = dataLines.reduce((sum, line) => {
        const cells = parseCsvLine(line);
        return sum + Number(cells[5]);
      }, 0);

      expect(total).toBe((await loadUsageReport(userId)).totalCents);
    });

    it('quotes a title containing a comma so columns do not shift', async () => {
      const csv = await loadUsageCsv(userId);
      expect(csv).toContain('"Series B, with a comma"');

      const dataLines = csv.trimEnd().split('\r\n').slice(1);
      for (const line of dataLines) {
        expect(parseCsvLine(line)).toHaveLength(8);
      }
    });
  });
});

describe('CSV quoting', () => {
  it('escapes quotes by doubling them', () => {
    expect(csvCell('she said "no"')).toBe('"she said ""no"""');
  });

  it('quotes cells containing commas and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('leaves ordinary values unquoted', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });

  /**
   * A series title is user input, and a leading `=` makes Excel evaluate the cell
   * as a formula when the export is opened.
   */
  it('neutralises formula injection', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
  });

  it('emits CRLF line endings and a trailing newline', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2\r\n');
  });
});

/** Minimal RFC 4180 reader, enough to verify our writer. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}
