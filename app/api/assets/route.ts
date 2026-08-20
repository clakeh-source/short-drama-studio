import { z } from 'zod';
import { route } from '@/lib/api/handler';
import { loadAssetLibrary } from '@/lib/data/assets';

/**
 * Everything this user has generated, across every series.
 *
 * A read-only view over four tables that each own their objects. Nothing here
 * deletes or mutates: the Assets page is where you find something, and
 * `POST /api/assets/[id]/reuse` is where you do something with it.
 */
const querySchema = z.object({
  kind: z.enum(['video', 'image', 'voice', 'music', 'sfx']).optional(),
  seriesId: z.uuid().optional(),
  origin: z.enum(['shot', 'character', 'render']).optional(),
});

export const GET = route<undefined, z.infer<typeof querySchema>>(
  { operation: 'assets.list', query: querySchema },
  async ({ query, user }) => {
    const library = await loadAssetLibrary(user.id, {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.seriesId ? { seriesId: query.seriesId } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
    });

    return library;
  },
);
