import Link from 'next/link';
import { ChevronLeft, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { GenerationPanel } from '@/components/generation/generation-panel';
import { requireUser } from '@/lib/auth';
import { notFound } from '@/lib/api/handler';
import { loadStoryboardPage } from '@/lib/data/storyboard';
import { buildEpisodeStatus } from '@/lib/data/generation';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

export const dynamic = 'force-dynamic';

export default async function GeneratePage({
  params,
}: {
  params: Promise<{ id: string; number: string }>;
}) {
  const user = await requireUser();
  const { id, number } = await params;

  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber)) throw notFound('Episode not found');

  /**
   * One transaction for the episode and its board, then the two remaining reads
   * in parallel.
   *
   * This page was four sequential `withUserDb` calls — episode, board, spend,
   * progress — and each one costs about 140ms against a database in another
   * region (a `BEGIN`, two `set_config` statements, the query, a `COMMIT`).
   * Fully rendering it took 1.5 seconds, the slowest page in the app, and it is
   * the page where the user commits money. Reusing `loadStoryboardPage` collapses
   * the first two; the progress and spend reads below need nothing from each
   * other, so they overlap.
   */
  const board = await loadStoryboardPage(user.id, id, parsedNumber);
  const { episode } = board;
  const allShots = board.scenes.flatMap((s) => s.shots);

  if (allShots.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Breadcrumb id={id} number={parsedNumber} title={episode.title} status={episode.status} />
        <Card>
          <CardContent className="p-12 text-center">
            <h2 className="font-medium">No storyboard yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              An episode has to be broken into shots before anything can be generated.
            </p>
            <Link
              href={`/series/${id}/episodes/${parsedNumber}/storyboard`}
              className="mt-4 inline-block text-sm text-primary hover:underline"
            >
              Go to the storyboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pending = allShots.filter((s) => s.status !== 'ready');
  const estimate = estimateEpisodeCost(pending, getVideoProvider(), getTtsProvider());

  // `checkSpend` only needs the estimate to compare against the cap — the query
  // it runs is the month's total, which does not depend on this episode at all.
  // So it overlaps with the progress read rather than queueing behind it.
  const [spend, status] = await Promise.all([
    checkSpend(user.id, estimate.totalCents),
    buildEpisodeStatus(user.id, episode.id),
  ]);


  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Breadcrumb id={id} number={parsedNumber} title={episode.title} status={episode.status} />

      <GenerationPanel
        episodeId={episode.id}
        estimateCents={estimate.totalCents}
        spentCents={spend.spentCents}
        capCents={spend.capCents}
        initial={status}
      />
    </div>
  );
}

function Breadcrumb({
  id,
  number,
  title,
  status,
}: {
  id: string;
  number: number;
  title: string;
  status: string;
}) {
  return (
    <div>
      <Link
        href={`/series/${id}/episodes/${number}/storyboard`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Storyboard
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{title || `Episode ${number}`}</h1>
        <Badge variant="outline">{status}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Each shot becomes one generated clip. Three run at a time.
      </p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link href={`/series/${id}/episodes/${number}/export`}>
          <Download />
          Assemble and export
        </Link>
      </Button>
    </div>
  );
}
