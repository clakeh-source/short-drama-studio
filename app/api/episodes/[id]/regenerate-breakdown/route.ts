import { sseRoute } from '@/lib/api/sse';
import { runBreakdown } from '@/lib/data/breakdown';

/**
 * Re-runs the breakdown without discarding work in progress.
 *
 * A scene containing a shot that is queued, generating, or already has a clip is
 * left exactly as it is — rows, prompts, durations and all — even if the new
 * breakdown reads that scene differently. Everything else is rebuilt, scenes the
 * script has gained are added, and scenes it has lost are removed unless they
 * are holding something in flight.
 *
 * The `done` event carries the diff, because "we re-read your script" is not a
 * useful thing to tell someone: they need to know what moved and what did not.
 */
export const POST = sseRoute<{ id: string }>(
  { operation: 'breakdown.regenerate' },
  async ({ params, user, send }) => {
    const result = await runBreakdown({
      userId: user.id,
      episodeId: params.id,
      mode: 'merge',
      onDelta: (chunk) => send('delta', chunk),
      onStatus: (message) => send('status', { message }),
    });

    send('done', result);
  },
);

export const maxDuration = 300;
