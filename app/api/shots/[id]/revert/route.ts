import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { assets, shots } from '@/lib/db/schema';
import { reconcileShotStatus } from '@/lib/data/generation';
import { signedUrl } from '@/lib/storage';
import { log } from '@/lib/log';

/**
 * Points a shot back at one of its earlier takes.
 *
 * Reverting is a pointer move, not a generation: the clip already exists in
 * storage and nothing is re-rendered, re-charged or re-queued. That is the whole
 * reason versions are kept rather than overwritten — undoing a regeneration you
 * did not like should cost nothing and take no time.
 *
 * Only a take that actually produced a clip can be reverted to. A failed version
 * is in the history so the user can see it failed, not so they can switch to it.
 */
const bodySchema = z.object({
  version: z.int().min(1),
});

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'shot.revert', body: bodySchema },
  async ({ body, params, user }) => {
    const reverted = await withUserDb(user.id, async (tx) => {
      const [shot] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!shot) throw notFound('Shot not found');

      if (shot.version === body.version) {
        return { shot, target: null, alreadyActive: true as const };
      }

      const [target] = await tx
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.shotId, params.id),
            eq(assets.kind, 'video'),
            eq(assets.version, body.version),
            eq(assets.status, 'ready'),
          ),
        );

      if (!target?.storagePath) {
        throw badRequest(
          `Version ${body.version} of this shot has no finished clip to revert to.`,
        );
      }

      // Moving the pointer is the whole operation. `retryCount` comes back to
      // the take's own, so a later retry of the reverted version numbers from
      // where that take left off rather than from the abandoned one.
      const [updated] = await tx
        .update(shots)
        .set({
          version: body.version,
          retryCount: (target.meta as { attempt?: number } | null)?.attempt ?? 0,
        })
        .where(eq(shots.id, params.id))
        .returning();

      return { shot: updated!, target, alreadyActive: false as const };
    });

    if (reverted.alreadyActive) {
      return { reverted: false, version: reverted.shot.version, message: 'Already the active take.' };
    }

    // Assets other than the reverted take may now disagree with the shot, so let
    // the reconciler decide the status rather than assuming `ready`: a shot with
    // dialogue still needs its voice track.
    const status = await reconcileShotStatus(params.id);

    log.info('shot reverted to an earlier take', {
      userId: user.id,
      shotId: params.id,
      operation: 'shot.revert',
      version: reverted.shot.version,
    });

    return {
      reverted: true,
      version: reverted.shot.version,
      status,
      // The new active output, so the player can switch without another round trip.
      videoUrl: await signedUrl(reverted.target!.storagePath!),
    };
  },
);
