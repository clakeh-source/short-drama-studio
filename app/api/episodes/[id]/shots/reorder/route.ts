import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { scenes, shots } from '@/lib/db/schema';

const bodySchema = z.object({
  /** Shots grouped by scene, each list already in its intended order. */
  scenes: z
    .array(
      z.object({
        sceneId: z.uuid(),
        shotIds: z.array(z.uuid()).min(1),
      }),
    )
    .min(1),
});

/**
 * Persists a drag-to-reorder.
 *
 * `order_index` is unique per scene, so the rewrite happens in two passes: push
 * every affected shot into a scratch range first, then write the final indices.
 * Doing it in one pass would collide with an index the same scene still holds.
 * The whole thing is one transaction, so a failure leaves the old order intact.
 */
export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'shots.reorder', body: bodySchema },
  async ({ body, params, user }) => {
    return withUserDb(user.id, async (tx) => {
      const sceneRows = await tx
        .select({ id: scenes.id })
        .from(scenes)
        .where(eq(scenes.episodeId, params.id));

      const owned = new Set(sceneRows.map((s) => s.id));
      for (const group of body.scenes) {
        if (!owned.has(group.sceneId)) {
          throw badRequest('That scene does not belong to this episode.');
        }
      }

      const allIds = body.scenes.flatMap((g) => g.shotIds);
      if (new Set(allIds).size !== allIds.length) {
        throw badRequest('The same shot appears twice in the requested order.');
      }

      // Every referenced shot must already live in this episode. RLS covers
      // ownership; this covers cross-episode mix-ups.
      const existing = await tx
        .select({ id: shots.id, sceneId: shots.sceneId })
        .from(shots)
        .where(inArray(shots.id, allIds));

      if (existing.length !== allIds.length) {
        throw badRequest('One of those shots no longer exists. Reload and try again.');
      }
      for (const shot of existing) {
        if (!owned.has(shot.sceneId)) {
          throw badRequest('One of those shots belongs to a different episode.');
        }
      }

      // Pass 1 — park everything above any index in use.
      const SCRATCH = 100_000;
      for (const [index, id] of allIds.entries()) {
        await tx
          .update(shots)
          .set({ orderIndex: SCRATCH + index })
          .where(eq(shots.id, id));
      }

      // Pass 2 — write the real positions, including any scene reassignment.
      let moved = 0;
      for (const group of body.scenes) {
        for (const [orderIndex, id] of group.shotIds.entries()) {
          await tx
            .update(shots)
            .set({ sceneId: group.sceneId, orderIndex })
            .where(eq(shots.id, id));
          moved += 1;
        }
      }

      return { reordered: true, shotCount: moved };
    });
  },
);
