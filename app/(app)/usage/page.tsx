import { desc } from 'drizzle-orm';
import { Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth';
import { withUserDb } from '@/lib/db';
import { usageLog } from '@/lib/db/schema';
import { getSpendSummary } from '@/lib/usage';
import { loadUsageReport, type UsageBucket } from '@/lib/data/usage-report';
import { formatCents } from '@/lib/utils';

export const metadata = { title: 'Usage · Short Drama Studio' };
export const dynamic = 'force-dynamic';

export default async function UsagePage() {
  const user = await requireUser();
  const [spend, report, rows] = await Promise.all([
    getSpendSummary(user.id),
    loadUsageReport(user.id),
    withUserDb(user.id, (tx) =>
      tx.select().from(usageLog).orderBy(desc(usageLog.createdAt)).limit(100),
    ),
  ]);

  const peakDay = Math.max(1, ...report.byDay.map((d) => d.costCents));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every provider call, with its cost. Last {report.windowDays} days.
          </p>
        </div>
        <a
          href="/api/usage/export"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted"
        >
          <Download className="size-4" />
          Export CSV
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="This month" value={formatCents(spend.spentCents)} />
        <Figure
          label="Monthly cap"
          value={formatCents(spend.capCents)}
          {...(spend.overCap ? { hint: 'reached — generation is blocked' } : {})}
        />
        <Figure label="Clips produced" value={String(report.clipCount)} />
        <Figure label="Voice tracks" value={String(report.voiceCount)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure
          label={`Spend, last ${report.windowDays}d`}
          value={formatCents(report.totalCents)}
          hint={`${report.totalCalls} provider calls`}
        />
        <Figure
          label="Tokens in"
          value={report.tokensIn.toLocaleString('en-US')}
          hint="LLM calls only"
        />
        <Figure label="Tokens out" value={report.tokensOut.toLocaleString('en-US')} />
      </div>

      {/* ------------------------------------------------------------ by day */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spend by day</CardTitle>
        </CardHeader>
        <CardContent>
          {report.byDay.length === 0 ? (
            <Empty>Nothing spent in the last {report.windowDays} days.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {report.byDay.map((day) => (
                <li key={day.day} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {day.day}
                  </span>
                  <span className="flex h-4 flex-1 items-center">
                    <span
                      className="h-2 rounded-sm bg-primary"
                      /* Width is data, not styling, so it has to be inline. */
                      style={{ width: `${Math.max(2, (day.costCents / peakDay) * 100)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono tabular-nums">
                    {formatCents(day.costCents)}
                  </span>
                  <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {day.calls}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Breakdown title="By provider" buckets={report.byProvider} total={report.totalCents} />
        <Breakdown title="By series" buckets={report.bySeries} total={report.totalCents} />
        <Breakdown title="By operation" buckets={report.byOperation} total={report.totalCents} />
      </div>

      {/* --------------------------------------------------------- raw ledger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <Empty>No provider calls recorded yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 pr-4 font-medium">Operation</th>
                    <th className="py-2 pr-4 text-right font-medium">Tokens</th>
                    <th className="py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="py-2 pr-4 text-muted-foreground">
                        {row.createdAt.toISOString().replace('T', ' ').slice(0, 16)}
                      </td>
                      <td className="py-2 pr-4">{row.provider}</td>
                      <td className="py-2 pr-4">{row.operation}</td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums">
                        {row.tokensIn ?? 0} / {row.tokensOut ?? 0}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatCents(row.costCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure(props: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{props.label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-2xl tabular-nums">{props.value}</p>
        {props.hint ? <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Breakdown(props: {
  title: string;
  buckets: ReadonlyArray<UsageBucket & { seriesId?: string | null }>;
  total: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.buckets.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <dl className="space-y-2 text-sm">
            {props.buckets.map((bucket) => (
              <div key={bucket.key} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 truncate" title={bucket.key}>
                  {bucket.key}
                  <span className="ml-1.5 text-xs text-muted-foreground">×{bucket.calls}</span>
                </dt>
                <dd className="shrink-0 font-mono tabular-nums">{formatCents(bucket.costCents)}</dd>
              </div>
            ))}
            {/* Shown so the page reconciles by eye, not only by test. */}
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 font-medium">
              <dt>Total</dt>
              <dd className="font-mono tabular-nums">{formatCents(props.total)}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Empty(props: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{props.children}</p>;
}
