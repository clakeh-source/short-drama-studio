import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { MIN_SHOT_SECONDS } from '@/lib/shots';
import { withUserDb } from '@/lib/db';
import { shots } from '@/lib/db/schema';
import { getVideoProvider } from '@/lib/providers';
import { recomposeShot, styleSuffixForScene } from '@/lib/data/storyboard';

const bodySchema = z.object({
  /** Where to cut, in seconds from the shot's start. Defaults to the middle. */
  atSeconds: z.number().min(1).optional(),
});

/**
 * Splits one shot into two consecutive shots.
 *
 * The second half inherits the cast, camera and dialogue but gets its own row,
 * so it can then be re-framed independently — the usual reason to split is that
 * one setup is doing the work of two.
 */
export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'shot.split', body: bodySchema },
  async ({ body, params, user }) => {
    const video = getVideoProvider();

    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!existing) throw notFound('Shot not found');

      if (existing.durationSeconds < MIN_SHOT_SECONDS * 2) {
        throw badRequest(
          `This shot is ${existing.durationSeconds}s — too short to split into two clips of at least ${MIN_SHOT_SECONDS}s.`,
        );
      }

      const cut = body.atSeconds ?? existing.durationSeconds / 2;
      const first = video.clampDuration(
        Math.min(Math.max(cut, MIN_SHOT_SECONDS), existing.durationSeconds - MIN_SHOT_SECONDS),
      );
      const second = video.clampDuration(Math.max(existing.durationSeconds - first, MIN_SHOT_SECONDS));

      // Make room for the new shot immediately after this one.
      await tx
        .update(shots)
        .set({ orderIndex: sql`${shots.orderIndex} + 1` })
        .where(
          and(eq(shots.sceneId, existing.sceneId), gt(shots.orderIndex, existing.orderIndex)),
        );

      await tx
        .update(shots)
        .set({ durationSeconds: first })
        .where(eq(shots.id, existing.id));

      const [inserted] = await tx
        .insert(shots)
        .values({
          sceneId: existing.sceneId,
          orderIndex: existing.orderIndex + 1,
          durationSeconds: second,
          camera: existing.camera,
          action: `${existing.action} (continued)`,
          // Dialogue stays on the first half; the second is the reaction.
          dialogue: null,
          speakerCharacterId: null,
          characterIds: existing.characterIds,
          promptOverride: null,
          status: 'pending',
        })
        .returning();

      const styleSuffix = await styleSuffixForScene(tx, existing.sceneId);
      await recomposeShot(tx, existing.id, styleSuffix);
      const shot = await recomposeShot(tx, inserted!.id, styleSuffix);

      return { split: true, newShot: shot };
    });
  },
);
