import { Badge } from '@/components/ui/badge';
import { getSpendSummary } from '@/lib/usage';
import { formatCents } from '@/lib/utils';

/**
 * The monthly spend readout in the top bar.
 *
 * Its own async component so it can stream. The summary is a `withUserDb`
 * transaction — a `BEGIN`, two `set_config` round trips, the sum and a `COMMIT`,
 * measured at 190-490ms against a database in another region — and it used to run
 * in the layout, which meant every page in the app waited on a header widget
 * before sending a single byte. Nothing below the header depends on it.
 */
export async function SpendMeter({ userId }: { userId: string }) {
  const spend = await getSpendSummary(userId);

  if (spend.unavailable) return <Badge variant="outline">spend unavailable</Badge>;

  const pct =
    spend.capCents > 0 ? Math.min(100, Math.round((spend.spentCents / spend.capCents) * 100)) : 0;

  return (
    <>
      <span className="font-mono text-sm tabular-nums">
        {formatCents(spend.spentCents)}{' '}
        <span className="text-muted-foreground">/ {formatCents(spend.capCents)}</span>
      </span>
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Monthly spend against cap"
      >
        <div
          className={spend.overCap ? 'h-full bg-destructive' : 'h-full bg-primary'}
          style={{ width: `${pct}%` }}
        />
      </div>
      {spend.overCap ? <Badge variant="destructive">cap reached</Badge> : null}
    </>
  );
}

/** Same width as the real meter, so the header does not shift when it lands. */
export function SpendMeterSkeleton() {
  return (
    <>
      <span className="h-4 w-20 animate-pulse rounded bg-muted" />
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" />
    </>
  );
}
