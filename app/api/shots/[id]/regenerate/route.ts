import { eq } from 'drizzle-orm';
import { badRequest, dynamicRoute, notFound, paymentRequired } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { scenes, shots } from '@/lib/db/schema';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { KEEP_SHOT_VERSIONS, loadShotVersions, pruneShotVersions } from '@/lib/data/generation';
import { loadEpisode } from '@/lib/data/series';
import { inngest, shotVideoEventId } from '@/lib/inngest/client';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * Starts a new take of one shot, keeping the old one.
 *
 * The difference from `/generate` is the whole point of this endpoint: that one
 * re-attempts the *current* take and overwrites it, this one begins a new take
 * and preserves what was there. Which is why it is a separate route rather than
 * a flag — "try again" and "give me another version" want opposite things from
 * the previous clip, and a boolean makes it too easy to pick the wrong one.
 *
 * Touches nothing but this shot. Its siblings' rows, statuses, versions and
 * queued jobs are all unaffected.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'shot.regenerate' },
  async ({ params, user }) => {
    const prepared = await withUserDb(user.id, async (tx) => {
      const [shot] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!shot) throw notFound('Shot not found');

      const [scene] = await tx.select().from(scenes).where(eq(scenes.id, shot.sceneId));
      if (!scene) throw notFound('Scene not found');

      if (!shot.promptOverride && !shot.videoPrompt) {
        throw badRequest('This shot has no video prompt. Regenerate the storyboard.');
      }

      const version = shot.version + 1;

      // A new take starts its retry budget over: the previous take's failures
      // say nothing about this one's chances.
      const [updated] = await tx
        .update(shots)
        .set({ version, retryCount: 0, status: 'queued' })
        .where(eq(shots.id, params.id))
        .returning();

      return { shot: updated!, episodeId: scene.episodeId, version };
    });

    const { episode, series } = await loadEpisode(user.id, prepared.episodeId);

    const estimate = estimateEpisodeCost([prepared.shot], getVideoProvider(), getTtsProvider());
    const spend = await checkSpend(user.id, estimate.totalCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    /**
     * Prune before enqueueing, not after.
     *
     * The new take's own row does not exist yet, so this counts only finished
     * takes — meaning the shot is left holding exactly KEEP_SHOT_VERSIONS of
     * history plus the one about to be made. Doing it afterwards would race the
     * job, which writes its row the moment it starts.
     */
    const pruned = await pruneShotVersions(params.id, KEEP_SHOT_VERSIONS);

    const { ids } = await inngest.send({
      // Version 0 attempts: a fresh take, not a retry of the last one.
      id: shotVideoEventId(params.id, 0, prepared.version),
      name: 'shot/video.requested',
      data: {
        userId: user.id,
        seriesId: series.id,
        episodeId: episode.id,
        shotId: params.id,
        attempt: 0,
        version: prepared.version,
      },
    });

    return {
      queued: true,
      version: prepared.version,
      keptVersions: (await loadShotVersions(params.id)).map((a) => a.version),
      prunedVersions: pruned.prunedVersions,
      eventIds: ids,
      estimateCents: estimate.totalCents,
    };
  },
);
