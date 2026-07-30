import { conflict } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { protectedShotsFor, runBreakdown } from '@/lib/data/breakdown';

/**
 * Breaks the episode's stored script into scenes and shots.
 *
 * Destructive by design: it rebuilds the board from scratch, which is what you
 * want the first time and after a script rewrite. It refuses rather than
 * silently destroying anything already generating or generated — that case has
 * its own endpoint, /regenerate-breakdown, which merges instead.
 */
export const POST = sseRoute<{ id: string }>(
  { operation: 'breakdown.generate' },
  async ({ params, user, send }) => {
    const inFlight = await protectedShotsFor(user.id, params.id);

    if (inFlight.length > 0) {
      throw conflict(
        `${inFlight.length} shot${inFlight.length === 1 ? ' is' : 's are'} already generating ` +
          'or generated. Rebuilding the board would discard them — use ' +
          '/regenerate-breakdown, which keeps them.',
      );
    }

    const result = await runBreakdown({
      userId: user.id,
      episodeId: params.id,
      mode: 'replace',
      onDelta: (chunk) => send('delta', chunk),
      onStatus: (message) => send('status', { message }),
    });

    send('done', result);
  },
);

/**
 * A feature-length script is a large prompt and a large answer. Vercel's default
 * ceiling would kill this mid-stream; 300s is the Pro maximum. See docs/DEPLOY.md.
 */
export const maxDuration = 300;
