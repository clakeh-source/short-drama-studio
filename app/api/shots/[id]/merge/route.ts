import { and, eq, gt, sql } from 'drizzle-orm';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { MAX_SHOT_SECONDS } from '@/lib/shots';
import { withUserDb } from '@/lib/db';
import { shots } from '@/lib/db/schema';
import { getVideoProvider } from '@/lib/providers';
import { recomposeShot, styleSuffixForScene } from '@/lib/data/storyboard';

/**
 * Merges this shot with the one after it, within the same scene.
 *
 * The surviving shot keeps this one's camera and takes the combined duration,
 * clamped to what the provider will render. Merging across a scene boundary is
 * refused — a scene change is a location change, and one clip cannot span it.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'shot.merge' },
  async ({ params, user }) => {
    const video = getVideoProvider();

    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!existing) throw notFound('Shot not found');

      const [next] = await tx
        .select()
        .from(shots)
        .where(
          and(
            eq(shots.sceneId, existing.sceneId),
            eq(shots.orderIndex, existing.orderIndex + 1),
          ),
        );

      if (!next) {
        throw badRequest('This is the last shot in its scene — there is nothing to merge it with.');
      }

      const combined = video.clampDuration(
        Math.min(existing.durationSeconds + next.durationSeconds, MAX_SHOT_SECONDS),
      );

      // Union of both casts, preserving order and dropping duplicates.
      const characterIds = [...new Set([...existing.characterIds, ...next.characterIds])];

      await tx.delete(shots).where(eq(shots.id, next.id));

      await tx
        .update(shots)
        .set({
          durationSeconds: combined,
          action: `${existing.action} ${next.action}`.slice(0, 400),
          characterIds,
          dialogue: existing.dialogue ?? next.dialogue,
          speakerCharacterId: existing.speakerCharacterId ?? next.speakerCharacterId,
        })
        .where(eq(shots.id, existing.id));

      await tx
        .update(shots)
        .set({ orderIndex: sql`${shots.orderIndex} - 1` })
        .where(and(eq(shots.sceneId, existing.sceneId), gt(shots.orderIndex, next.orderIndex)));

      const styleSuffix = await styleSuffixForScene(tx, existing.sceneId);
      const shot = await recomposeShot(tx, existing.id, styleSuffix);

      return { merged: true, shot };
    });
  },
);
