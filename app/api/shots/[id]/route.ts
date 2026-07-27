import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { CAMERA_VOCABULARY } from '@/lib/ai/prompts';
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from '@/lib/shots';
import { withUserDb } from '@/lib/db';
import { shots } from '@/lib/db/schema';
import { recomposeShot, styleSuffixForScene } from '@/lib/data/storyboard';

const patchSchema = z.object({
  camera: z.enum(CAMERA_VOCABULARY).optional(),
  action: z.string().min(1).max(400).optional(),
  dialogue: z.string().max(300).nullable().optional(),
  durationSeconds: z.number().int().min(MIN_SHOT_SECONDS).max(MAX_SHOT_SECONDS).optional(),
  speakerCharacterId: z.uuid().nullable().optional(),
  characterIds: z.array(z.uuid()).max(6).optional(),
  /**
   * The human's replacement for the composed prompt. Send `null` to drop the
   * override and fall back to composition.
   */
  promptOverride: z.string().max(2000).nullable().optional(),
});

/**
 * Edits one shot and recomposes its prompts. Anything that changes what the
 * prompt should say — camera, action, cast — triggers recomposition; an
 * override short-circuits it inside the composer.
 */
export const PATCH = dynamicRoute<{ id: string }, z.infer<typeof patchSchema>>(
  { operation: 'shot.update', body: patchSchema },
  async ({ body, params, user }) => {
    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!existing) throw notFound('Shot not found');

      const updates: Record<string, unknown> = {};
      if (body.camera !== undefined) updates.camera = body.camera;
      if (body.action !== undefined) updates.action = body.action;
      if (body.dialogue !== undefined) updates.dialogue = body.dialogue;
      if (body.durationSeconds !== undefined) updates.durationSeconds = body.durationSeconds;
      if (body.speakerCharacterId !== undefined) {
        updates.speakerCharacterId = body.speakerCharacterId;
      }
      if (body.characterIds !== undefined) updates.characterIds = body.characterIds;
      if (body.promptOverride !== undefined) {
        updates.promptOverride = body.promptOverride?.trim() ? body.promptOverride : null;
      }

      if (Object.keys(updates).length === 0) return { updated: false };

      await tx.update(shots).set(updates).where(eq(shots.id, params.id));

      const styleSuffix = await styleSuffixForScene(tx, existing.sceneId);
      const shot = await recomposeShot(tx, params.id, styleSuffix);

      return { updated: true, shot };
    });
  },
);

/** Deletes a shot and closes the gap it leaves in `order_index`. */
export const DELETE = dynamicRoute<{ id: string }>(
  { operation: 'shot.delete' },
  async ({ params, user }) => {
    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!existing) throw notFound('Shot not found');

      const siblings = await tx
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, existing.sceneId));

      if (siblings.length <= 1) {
        // A scene with no shots would silently vanish from the render.
        throw badRequest('A scene has to keep at least one shot. Delete the scene instead.');
      }

      await tx.delete(shots).where(eq(shots.id, params.id));
      await tx
        .update(shots)
        .set({ orderIndex: sql`${shots.orderIndex} - 1` })
        .where(
          and(eq(shots.sceneId, existing.sceneId), gt(shots.orderIndex, existing.orderIndex)),
        );

      return { deleted: true };
    });
  },
);
