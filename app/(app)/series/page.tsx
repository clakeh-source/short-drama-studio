import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { Film, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth';
import { withUserDb } from '@/lib/db';
import { series } from '@/lib/db/schema';

export const metadata = { title: 'Series · Short Drama Studio' };
export const dynamic = 'force-dynamic';

export default async function SeriesPage() {
  const user = await requireUser();

  // No user_id filter here on purpose: RLS scopes the read. If this ever
  // returns another user's row, the policy is broken — see tests/rls.test.ts.
  const rows = await withUserDb(user.id, (tx) =>
    tx.select().from(series).orderBy(desc(series.createdAt)).limit(50),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Series</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A premise becomes a bible, then episodes, then finished vertical video.
          </p>
        </div>
        <Button asChild>
          <Link href="/series/new">
            <Plus />
            New series
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <Film className="size-8 text-muted-foreground" />
            <h2 className="font-medium">No series yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Start with one line: who wants what, and what is in the way.
            </p>
            <Button asChild className="mt-2">
              <Link href="/series/new">
                <Plus />
                New series
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <Card key={row.id} className="transition-colors hover:border-primary/50">
              <Link href={`/series/${row.id}`} className="block">
                <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{row.title}</CardTitle>
                  <Badge variant="outline">{row.status}</Badge>
                </div>
                  <CardDescription className="line-clamp-3">{row.logline}</CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {row.episodeTargetCount} × {row.episodeTargetSeconds}s ·{' '}
                  {row.genre || 'unset genre'}
                </CardContent>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
