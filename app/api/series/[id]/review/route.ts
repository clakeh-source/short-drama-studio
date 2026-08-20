import { dynamicRoute } from '@/lib/api/handler';
import { loadReviewTree } from '@/lib/data/review';

/**
 * The review board's state, polled every five seconds while anything is moving.
 *
 * Same builder as the server page's first paint, so the two cannot drift — the
 * poll is a refresh of exactly what was rendered, not a second opinion about it.
 *
 * `force-dynamic` because a cached board is a board that does not update, which
 * is the one thing this endpoint exists to do.
 */
export const dynamic = 'force-dynamic';

export const GET = dynamicRoute<{ id: string }>(
  { operation: 'series.review' },
  ({ params, user }) => loadReviewTree(user.id, params.id),
);
