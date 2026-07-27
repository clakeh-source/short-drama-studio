import { and, eq, gt, sql } from 'drizzle-orm';
import { dynamicRoute, notFound } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { shots } from '@/lib/db/schema';
import { recomposeShot, styleSuffixForScene } from '@/lib/data/storyboard';

/**
 * Copies a shot, placing the copy directly after the original.
 *
 * Distinct from `split`: split divides one shot's running time between two rows,
 * whereas duplicating adds time — the usual reason is to cover the same beat from
 * a second angle, so everything except generated state is carried over.
 *
 * Nothing generated comes with it. The copy starts at `pending` with no assets and
 * no provider job, because a clip belongs to the shot it was generated for; the
 * alternative is two rows pointing at one file, where deleting either takes the
 * other's video with it.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'shot.duplicate' },
  async ({ params, user }) => {
    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!existing) throw notFound('Shot not found');

      // Make room immediately after this shot.
      await tx
        .update(shots)
        .set({ orderIndex: sql`${shots.orderIndex} + 1` })
        .where(and(eq(shots.sceneId, existing.sceneId), gt(shots.orderIndex, existing.orderIndex)));

      const [inserted] = await tx
        .insert(shots)
        .values({
          sceneId: existing.sceneId,
          orderIndex: existing.orderIndex + 1,
          durationSeconds: existing.durationSeconds,
          camera: existing.camera,
          action: existing.action,
          dialogue: existing.dialogue,
          speakerCharacterId: existing.speakerCharacterId,
          characterIds: existing.characterIds,
          // A hand-written prompt is the point of duplicating — keep it.
          promptOverride: existing.promptOverride,
          status: 'pending',
        })
        .returning();

      const styleSuffix = await styleSuffixForScene(tx, existing.sceneId);
      const shot = await recomposeShot(tx, inserted!.id, styleSuffix);

      return { duplicated: true, newShot: shot };
    });
  },
);
