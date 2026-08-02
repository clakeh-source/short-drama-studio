import { dynamicRoute } from '@/lib/api/handler';
import { loadRun, updateRun } from '@/lib/data/runs';

/**
 * Stops a run, from the row rather than through the supervisor.
 *
 * The gate endpoint answers a *question the supervisor is asking* — it sends an
 * event that a waiting step consumes. That is the right mechanism at a gate and
 * useless everywhere else: a run nothing has picked up is not waiting on an
 * event, so telling it to stop through the event bus tells nothing.
 *
 * This writes `cancelled` directly. The supervisor re-reads the row at the top
 * of every stage, so a running job stops at its next boundary, and a job that
 * was never picked up is simply no longer pending — which is what someone
 * staring at a stuck run actually wants.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'run.cancel' },
  async ({ params, user }) => {
    // Through `loadRun` so RLS decides whether this run is theirs, rather than
    // the update silently affecting zero rows and reporting success.
    const run = await loadRun(user.id, params.id);

    if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      return { run, alreadySettled: true };
    }

    const updated = await updateRun(run.id, { status: 'cancelled', gateExpiresAt: null });
    return { run: updated, alreadySettled: false };
  },
);
