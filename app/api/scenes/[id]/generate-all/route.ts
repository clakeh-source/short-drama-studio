import { asc, eq } from 'drizzle-orm';
import { dynamicRoute, notFound, paymentRequired } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { scenes, shots } from '@/lib/db/schema';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { MAX_INFLIGHT_VIDEO_JOBS, setShotStatus } from '@/lib/data/generation';
import { loadEpisode } from '@/lib/data/series';
import { inngest, shotVideoEventId, shotVoiceEventId } from '@/lib/inngest/client';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * Enqueues every unfinished shot in one scene.
 *
 * All of them go onto the queue at once and the queue decides when each runs —
 * there is deliberately no throttling here. The three-at-a-time cap belongs to
 * the queue (`concurrency` keyed on the series) and to the slot lease the worker
 * takes before it spends anything; putting a second limiter in the request path
 * would give two answers to one question, and the one in the request path is the
 * one that cannot see what other episodes are already doing.
 *
 * Shots that are already `ready` are skipped rather than regenerated. Redoing a
 * finished clip costs money and is what /shots/:id/regenerate is for.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'scene.generate_all' },
  async ({ params, user, idempotencyKey }) => {
    const prepared = await withUserDb(user.id, async (tx) => {
      const [scene] = await tx.select().from(scenes).where(eq(scenes.id, params.id));
      if (!scene) throw notFound('Scene not found');

      const rows = await tx
        .select()
        .from(shots)
        .where(eq(shots.sceneId, params.id))
        .orderBy(asc(shots.orderIndex));

      return { scene, shots: rows };
    });

    if (prepared.shots.length === 0) {
      throw notFound('This scene has no shots yet.');
    }

    const pending = prepared.shots.filter(
      (shot) => shot.status !== 'ready' && Boolean(shot.promptOverride ?? shot.videoPrompt),
    );

    if (pending.length === 0) {
      return {
        queued: 0,
        skipped: prepared.shots.length,
        reason: 'every shot in this scene is already generated',
      };
    }

    const { episode, series } = await loadEpisode(user.id, prepared.scene.episodeId);

    // One check for the whole scene, so going over the cap enqueues nothing
    // rather than half a scene.
    const estimate = estimateEpisodeCost(pending, getVideoProvider(), getTtsProvider());
    const spend = await checkSpend(user.id, estimate.totalCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    await withUserDb(user.id, async () => {
      for (const shot of pending) await setShotStatus(shot.id, 'queued');
    });

    const { ids } = await inngest.send(
      pending.flatMap((shot) => [
        {
          id: shotVideoEventId(shot.id, shot.retryCount, shot.version),
          name: 'shot/video.requested' as const,
          data: {
            userId: user.id,
            seriesId: series.id,
            episodeId: episode.id,
            shotId: shot.id,
            attempt: shot.retryCount,
            version: shot.version,
          },
        },
        ...(shot.dialogue?.trim()
          ? [
              {
                id: shotVoiceEventId(shot.id, shot.retryCount),
                name: 'shot/voice.requested' as const,
                data: {
                  userId: user.id,
                  episodeId: episode.id,
                  shotId: shot.id,
                  attempt: shot.retryCount,
                },
              },
            ]
          : []),
      ]),
    );

    return {
      queued: pending.length,
      skipped: prepared.shots.length - pending.length,
      shotIds: pending.map((s) => s.id),
      eventIds: ids,
      estimateCents: estimate.totalCents,
      /** What the caller should expect to see running at once. */
      concurrencyLimit: MAX_INFLIGHT_VIDEO_JOBS,
      idempotencyKey,
    };
  },
);
