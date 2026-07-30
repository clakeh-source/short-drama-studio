import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { episodes } from '@/lib/db/schema';
import { loadEpisodeShotsForJob, setShotStatus } from '@/lib/data/generation';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { log } from '@/lib/log';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { assertWithinSpendCap, SpendCapError } from '@/lib/spend';
import { inngest, shotVideoEventId, shotVoiceEventId } from '../client';

/**
 * Fans an episode out into per-shot jobs.
 *
 * The spend check happens here, once, against the whole episode's estimate,
 * because Phase 3 AC #6 requires that going over the cap enqueues *nothing* —
 * not "enqueues eight of twelve and then stops". Individual jobs re-check on
 * their way through in case a concurrent episode moves the number.
 */
export const generateEpisodeAssets = inngest.createFunction(
  {
    id: 'episode-generate-assets',
    name: 'Generate episode assets',
    // One fan-out per episode at a time; a second request waits rather than
    // double-enqueueing the same shots.
    concurrency: { limit: 1, key: 'event.data.episodeId' },
    retries: 1,
  },
  { event: 'episode/generate.requested' },
  async ({ event, step }) => {
    const { userId, episodeId, shotIds } = event.data;
    const video = getVideoProvider();
    const tts = getTtsProvider();

    const plan = await step.run('plan', async () => {
      const { shots, series } = await loadEpisodeShotsForJob(episodeId, userId);

      if (shots.length === 0) {
        throw new NonRetriableError(
          'This episode has no shots yet. Break the script into shots first.',
        );
      }

      // Explicit selection, or everything not already finished.
      const selected = shotIds?.length
        ? shots.filter((s) => shotIds.includes(s.id))
        : shots.filter((s) => s.status !== 'ready');

      if (selected.length === 0) {
        return {
          seriesId: series.id,
          shots: [],
          estimateCents: 0,
          skipped: 'nothing to do' as const,
        };
      }

      const estimate = estimateEpisodeCost(selected, video, tts);

      try {
        await assertWithinSpendCap(userId, estimate.totalCents);
      } catch (error) {
        if (error instanceof SpendCapError) {
          log.warn('generation blocked by spend cap', {
            userId,
            episodeId,
            operation: 'episode.generate.blocked',
            costCents: estimate.totalCents,
          });
          // Non-retriable: the answer will not change on a retry, and no event
          // has been sent, so nothing is queued.
          throw new NonRetriableError(error.message);
        }
        throw error;
      }

      return {
        seriesId: series.id,
        shots: selected.map((s) => ({
          id: s.id,
          hasDialogue: Boolean(s.dialogue?.trim()),
          attempt: s.retryCount,
          version: s.version,
        })),
        estimateCents: estimate.totalCents,
      };
    });

    // Inngest types a step's return value as JSON-serialised, which widens
    // array members to nullable. Narrow once, here.
    const queuedShots = plan.shots.filter(
      (shot): shot is { id: string; hasDialogue: boolean; attempt: number; version: number } =>
        Boolean(shot),
    );

    if (queuedShots.length === 0) {
      return { queued: 0, reason: 'nothing to do' };
    }

    // Mark everything queued up front so the whole board changes state at once,
    // rather than trickling as events are accepted.
    await step.run('mark-queued', async () => {
      for (const shot of queuedShots) {
        await setShotStatus(shot.id, 'queued');
      }
      await db().update(episodes).set({ status: 'generating' }).where(eq(episodes.id, episodeId));
      return { marked: queuedShots.length };
    });

    await step.sendEvent(
      'fan-out',
      queuedShots.flatMap((shot) => [
        {
          id: shotVideoEventId(shot.id, shot.attempt, shot.version),
          name: 'shot/video.requested' as const,
          data: {
            userId,
            seriesId: plan.seriesId,
            episodeId,
            shotId: shot.id,
            attempt: shot.attempt,
            version: shot.version,
          },
        },
        ...(shot.hasDialogue
          ? [
              {
                id: shotVoiceEventId(shot.id, shot.attempt),
                name: 'shot/voice.requested' as const,
                data: { userId, episodeId, shotId: shot.id, attempt: shot.attempt },
              },
            ]
          : []),
      ]),
    );

    log.info('episode generation queued', {
      userId,
      episodeId,
      operation: 'episode.generate.queued',
      costCents: plan.estimateCents,
      shotCount: queuedShots.length,
    });

    return {
      queued: queuedShots.length,
      voiceJobs: queuedShots.filter((s) => s.hasDialogue).length,
      estimateCents: plan.estimateCents,
    };
  },
);
