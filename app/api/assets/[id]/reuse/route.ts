import { z } from 'zod';
import { ApiError, dynamicRoute } from '@/lib/api/handler';
import { ReuseError, reuseAsCharacterReference, reuseAsShotKeyframe } from '@/lib/assets/reuse';

/**
 * Uses a stored asset somewhere else.
 *
 * The destination decides what happens, and both destinations *copy* the
 * object — see the note in lib/assets/reuse.ts. The id in the path is a
 * library id (`shot:uuid`, `character:uuid`, `render:uuid`), resolved under RLS
 * so an id from a browser cannot reach another user's storage.
 */
const bodySchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('character-reference'),
    characterId: z.uuid(),
  }),
  z.object({
    target: z.literal('shot-keyframe'),
    shotId: z.uuid(),
  }),
]);

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'assets.reuse', body: bodySchema },
  async ({ body, params, user }) => {
    try {
      if (body.target === 'character-reference') {
        return await reuseAsCharacterReference({
          userId: user.id,
          libraryAssetId: params.id,
          characterId: body.characterId,
        });
      }

      return await reuseAsShotKeyframe({
        userId: user.id,
        libraryAssetId: params.id,
        shotId: body.shotId,
      });
    } catch (error) {
      // The reuse layer carries its own status because the same failure means
      // different things — a missing object is a 409, a missing row a 404 —
      // and flattening them to 500 would tell the user to retry something that
      // will never work.
      if (error instanceof ReuseError) {
        throw new ApiError(error.status, 'reuse_failed', error.message);
      }
      throw error;
    }
  },
);
