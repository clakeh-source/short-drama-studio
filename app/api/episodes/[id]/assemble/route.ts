import { dynamicRoute } from '@/lib/api/handler';
import { startAssembly } from '@/lib/data/assemble';

/**
 * Stitches the episode's finished clips into one video.
 *
 * Async, like every other job here: this queues the work and returns. Progress
 * and the finished file are read from `/api/episodes/:id/renders`.
 *
 * Refuses with 409 and the ids of the shots that are not generated yet, rather
 * than assembling what it has — a partial episode encodes perfectly well and is
 * indistinguishable from a finished one until somebody watches it.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'episode.assemble' },
  async ({ params, user }) => startAssembly(user.id, params.id),
);
