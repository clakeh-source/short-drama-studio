import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { assets, shots } from '@/lib/db/schema';
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from '@/lib/shots';
import { getVideoProvider } from '@/lib/providers';

const bodySchema = z.object({
  /** Omit to derive it from the voice clip that is overrunning. */
  durationSeconds: z.number().int().min(MIN_SHOT_SECONDS).max(MAX_SHOT_SECONDS).optional(),
});

/**
 * The one-click fix for Phase 3 AC #7: a voiceover longer than its clip.
 *
 * Lengthens the shot to fit the line, snapped to a duration the video provider
 * will actually render. The existing clip is now the wrong length, so the shot
 * drops back to `pending` — the UI prompts to regenerate it rather than silently
 * leaving a clip that no longer matches its slot on the timeline.
 */
export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'shot.extend', body: bodySchema },
  async ({ body, params, user }) => {
    const video = getVideoProvider();

    return withUserDb(user.id, async (tx) => {
      const [shot] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!shot) throw notFound('Shot not found');

      let target = body.durationSeconds;

      if (target === undefined) {
        const [voice] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.shotId, params.id), eq(assets.kind, 'voice')));

        const measured =
          (voice?.meta as { measuredSeconds?: number } | null)?.measuredSeconds ??
          voice?.durationSeconds ??
          null;

        if (measured === null) {
          throw badRequest(
            'There is no voice clip on this shot yet, so there is nothing to fit it to. ' +
              'Set a duration explicitly instead.',
          );
        }

        // A second of air after the line.
        target = Math.ceil(measured + 1);
      }

      const clamped = video.clampDuration(
        Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, target)),
      );

      if (clamped === shot.durationSeconds) {
        return {
          updated: false,
          durationSeconds: shot.durationSeconds,
          message:
            `This shot is already ${shot.durationSeconds}s, the longest the video provider will ` +
            `render. Shorten the line instead, or split the shot in two.`,
        };
      }

      await tx
        .update(shots)
        .set({
          durationSeconds: clamped,
          // The stored clip is the old length; it has to be regenerated.
          status: 'pending',
        })
        .where(eq(shots.id, params.id));

      return {
        updated: true,
        durationSeconds: clamped,
        previousDurationSeconds: shot.durationSeconds,
        needsRegeneration: true,
      };
    });
  },
);
