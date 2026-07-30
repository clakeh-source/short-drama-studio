import { eq } from 'drizzle-orm';
import { badRequest, dynamicRoute, notFound, paymentRequired } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { shots } from '@/lib/db/schema';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { loadEpisode } from '@/lib/data/series';
import { inngest, shotVideoEventId, shotVoiceEventId } from '@/lib/inngest/client';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';
import { scenes } from '@/lib/db/schema';

/**
 * Generates (or retries) a single shot — the manual "retry this shot" the spec
 * requires for non-retryable failures.
 *
 * A manual retry deliberately advances the attempt counter, which both gives the
 * new clip its own storage path and produces a fresh Inngest event id, so the
 * request is not deduplicated against the failed one.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'shot.generate' },
  async ({ params, user }) => {
    const prepared = await withUserDb(user.id, async (tx) => {
      const [shot] = await tx.select().from(shots).where(eq(shots.id, params.id));
      if (!shot) throw notFound('Shot not found');

      const [scene] = await tx.select().from(scenes).where(eq(scenes.id, shot.sceneId));
      if (!scene) throw notFound('Scene not found');

      if (!shot.promptOverride && !shot.videoPrompt) {
        throw badRequest('This shot has no video prompt. Regenerate the storyboard.');
      }

      // A retry is a new attempt; a first run keeps attempt 0. The *version* is
      // untouched either way — retrying is another go at the same take, and
      // only /regenerate starts a new one.
      const attempt =
        shot.status === 'failed' || shot.status === 'ready' ? shot.retryCount + 1 : shot.retryCount;

      if (attempt !== shot.retryCount) {
        await tx.update(shots).set({ retryCount: attempt }).where(eq(shots.id, params.id));
      }

      return { shot, episodeId: scene.episodeId, attempt, version: shot.version };
    });

    // Confirms the episode belongs to this user, and gives us the series id.
    const { episode, series } = await loadEpisode(user.id, prepared.episodeId);

    const estimate = estimateEpisodeCost(
      [prepared.shot],
      getVideoProvider(),
      getTtsProvider(),
    );
    const spend = await checkSpend(user.id, estimate.totalCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    const hasDialogue = Boolean(prepared.shot.dialogue?.trim());

    const { ids } = await inngest.send([
      {
        id: shotVideoEventId(params.id, prepared.attempt, prepared.version),
        name: 'shot/video.requested',
        data: {
          userId: user.id,
          seriesId: series.id,
          episodeId: episode.id,
          shotId: params.id,
          attempt: prepared.attempt,
          version: prepared.version,
        },
      },
      ...(hasDialogue
        ? [
            {
              id: shotVoiceEventId(params.id, prepared.attempt),
              name: 'shot/voice.requested' as const,
              data: {
                userId: user.id,
                episodeId: episode.id,
                shotId: params.id,
                attempt: prepared.attempt,
              },
            },
          ]
        : []),
    ]);

    return {
      queued: true,
      attempt: prepared.attempt,
      version: prepared.version,
      eventIds: ids,
      estimateCents: estimate.totalCents,
      seriesId: series.id,
    };
  },
);
