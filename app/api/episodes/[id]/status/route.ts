import { dynamicRoute } from '@/lib/api/handler';
import { buildEpisodeStatus } from '@/lib/data/generation';

/**
 * What the generation UI polls while jobs are in flight.
 *
 * Returns signed playback URLs for anything ready, and flags the shots whose
 * voiceover runs past the end of their clip (Phase 3 AC #7) so the UI can offer
 * the one-click fix rather than the editor discovering it at render time.
 *
 * The shape is built in `buildEpisodeStatus`, shared with the server page, so the
 * first paint and every poll after it cannot drift apart.
 */
export const GET = dynamicRoute<{ id: string }>({ operation: 'episode.status' }, ({ params, user }) =>
  buildEpisodeStatus(user.id, params.id),
);
