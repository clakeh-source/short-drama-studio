import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { ReviewBoard } from '@/components/review/review-board';
import { requireUser } from '@/lib/auth';
import { loadReviewTree } from '@/lib/data/review';

/**
 * The review board.
 *
 * Server-rendered for the first paint from the same builder the poll endpoint
 * uses, so the board is populated before any JavaScript runs and the first poll
 * is a refresh rather than a reveal.
 */
export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const tree = await loadReviewTree(user.id, id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/series/${id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {tree.title}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every episode, scene and shot in this series. Open a shot to see its takes.
        </p>
      </div>

      <ReviewBoard seriesId={id} initial={tree} />
    </div>
  );
}
