import { dynamicRoute } from '@/lib/api/handler';
import { loadRun, shotProgress, STAGE_ORDER } from '@/lib/data/runs';
import { loadReviewTree } from '@/lib/data/review';

/**
 * A run's state, polled by the workspace while it is going.
 *
 * Carries the shot counts and the review tree alongside the row, so one request
 * populates the whole progress view — the alternative is three polls racing each
 * other to describe the same moment.
 */
export const dynamic = 'force-dynamic';

export const GET = dynamicRoute<{ id: string }>(
  { operation: 'run.get' },
  async ({ params, user }) => {
    const run = await loadRun(user.id, params.id);

    const tree = run.seriesId ? await loadReviewTree(user.id, run.seriesId) : null;
    const episodeId = tree?.episodes[0]?.id ?? null;
    const progress = episodeId ? await shotProgress(episodeId) : null;

    return {
      run,
      /** Where the run is in the sequence, for a progress bar that means something. */
      stageIndex: STAGE_ORDER.indexOf(run.stage),
      stageCount: STAGE_ORDER.length - 1,
      /** Seconds left on the gate, or null when it is not waiting at one. */
      gateSecondsRemaining:
        run.status === 'awaiting_gate' && run.gateExpiresAt
          ? Math.max(0, Math.round((run.gateExpiresAt.getTime() - Date.now()) / 1000))
          : null,
      progress,
      tree,
    };
  },
);
