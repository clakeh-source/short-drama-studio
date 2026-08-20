import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { episodes } from '@/lib/db/schema';
import {
  buildEpisodeTimeline,
  createRenderRow,
  updateRenderRow,
} from '@/lib/data/render';
import { log } from '@/lib/log';
import { getRenderProvider } from '@/lib/providers';
import { assertWithinSpendCap, SpendCapError } from '@/lib/spend';
import { ingestFromUrl, renderPath } from '@/lib/storage';
import { recordUsage } from '@/lib/usage';
import { inngest } from '../client';
import { pollSchedule, toSleepDuration } from '../backoff';
import { shouldRetry } from '../retry';

/**
 * Assembles an episode into a single MP4.
 *
 * Same durable shape as the Phase 3 generation jobs: each provider interaction
 * is its own `step.run`, so a restart resumes rather than re-submitting. The
 * render row is created before the provider is called and updated in place, so a
 * failed render is always visible in the UI with its timeline intact and a retry
 * available — Phase 4 AC #6.
 *
 * This never generates a clip. It reads whatever assets exist, which is what
 * makes re-rendering after a single-shot edit reuse everything else (AC #5).
 */
export const renderEpisode = inngest.createFunction(
  {
    id: 'episode-render',
    name: 'Render episode',
    // One render per episode at a time; a second request queues behind it
    // rather than racing for the same output path.
    concurrency: { limit: 1, key: 'event.data.episodeId' },
    retries: 0,
  },
  { event: 'episode/render.requested' },
  async ({ event, step }) => {
    const { userId, episodeId, attempt } = event.data;
    const provider = getRenderProvider();
    const context = { userId, episodeId, provider: provider.id, attempt };

    /* -- 1. Build the timeline --------------------------------------------- */

    const plan = await step.run('build-timeline', async () => {
      const built = await buildEpisodeTimeline(userId, episodeId, { forJob: true });

      if (!built.readiness.ready) {
        const blocked = built.readiness.blockingShots;
        const summary = blocked
          .slice(0, 3)
          .map((s) => `shot ${s.orderIndex + 1} (${s.reason})`)
          .join(', ');
        throw new NonRetriableError(
          `${blocked.length} of ${built.readiness.shotCount} shots have no clip: ${summary}` +
            (blocked.length > 3 ? ', …' : '') +
            '. Generate those before rendering.',
        );
      }

      return {
        timeline: built.timeline,
        seriesId: built.seriesId,
        estimateCents: provider.estimateCostCents({
          clips: built.timeline.clips,
          voiceTracks: built.timeline.voiceTracks,
          captions: built.timeline.captions,
          aspectRatio: built.timeline.aspectRatio,
          resolution: built.timeline.resolution,
          ...(built.timeline.musicUrl ? { musicUrl: built.timeline.musicUrl } : {}),
        }),
      };
    });

    /* -- 2. Spend guard ---------------------------------------------------- */

    await step.run('spend-guard', async () => {
      try {
        await assertWithinSpendCap(userId, plan.estimateCents);
      } catch (error) {
        if (error instanceof SpendCapError) throw new NonRetriableError(error.message);
        throw error;
      }
      return { ok: true };
    });

    /* -- 3. Submit --------------------------------------------------------- */

    const renderRow = await step.run('create-render-row', async () => {
      const row = await createRenderRow({ episodeId, provider: provider.id });
      await db().update(episodes).set({ status: 'generating' }).where(eq(episodes.id, episodeId));
      return { id: row.id };
    });

    const submitted = await step.run('submit', async () => {
      const timeline = plan.timeline;
      const { providerJobId } = await provider.render({
        clips: timeline.clips.map((c) => ({
          url: c.url,
          durationSeconds: c.durationSeconds,
          startAt: c.startAt,
        })),
        voiceTracks: timeline.voiceTracks.map((v) => ({ url: v.url, startAt: v.startAt })),
        captions: timeline.captions.map((c) => ({
          text: c.text,
          startAt: c.startAt,
          endAt: c.endAt,
        })),
        aspectRatio: timeline.aspectRatio,
        resolution: timeline.resolution,
        ...(timeline.musicUrl ? { musicUrl: timeline.musicUrl } : {}),
      });

      await updateRenderRow(renderRow.id, { providerJobId, status: 'generating' });
      log.info('render submitted', { ...context, operation: 'render.submit', providerJobId });
      return { providerJobId };
    });

    /* -- 4. Poll ----------------------------------------------------------- */

    for (const [index, delay] of pollSchedule().entries()) {
      await step.sleep(`wait-${index}`, toSleepDuration(delay));

      const outcome = await step.run(`poll-${index}`, async () => {
        const result = await provider.poll(submitted.providerJobId);

        if (result.status === 'pending') return { done: false as const };

        if (result.status === 'failed') {
          log.warn('render failed', {
            ...context,
            operation: 'render.poll',
            error: result.error,
            retryable: result.retryable,
          });
          return {
            done: true as const,
            ok: false as const,
            error: result.error,
            retryable: result.retryable,
          };
        }

        const stored = await ingestFromUrl({
          url: result.url,
          bucket: 'renders',
          path: renderPath({ userId, episodeId, renderId: renderRow.id }),
        });

        await updateRenderRow(renderRow.id, {
          status: 'ready',
          storagePath: stored.storagePath,
          durationSeconds: Math.round(plan.timeline.totalSeconds),
          costCents: result.costCents,
          error: null,
          meta: {
            // Cross-cutting disclosure requirement.
            ai_generated: true,
            attempt,
            bytes: stored.bytes,
            resolution: plan.timeline.resolution,
            frameRate: 30,
            clipCount: plan.timeline.clips.length,
            captionCount: plan.timeline.captions.length,
            ...(result.meta ?? {}),
          },
        });

        await recordUsage({
          userId,
          seriesId: plan.seriesId,
          episodeId,
          provider: provider.id,
          operation: 'render.episode',
          costCents: result.costCents,
        });

        // The episode carries its own finished video, so "where is it" is a
        // column read rather than a scan of the attempt log for the newest
        // ready row.
        await db()
          .update(episodes)
          .set({
            status: 'rendered',
            outputStoragePath: stored.storagePath,
            durationSeconds: Math.round(plan.timeline.totalSeconds),
          })
          .where(eq(episodes.id, episodeId));

        log.info('render ready', {
          ...context,
          operation: 'render.ready',
          costCents: result.costCents,
        });

        return { done: true as const, ok: true as const, costCents: result.costCents };
      });

      if (!outcome.done) continue;

      if (outcome.ok) {
        return { episodeId, status: 'ready' as const, costCents: outcome.costCents, attempt };
      }

      const canRetry = shouldRetry(outcome.retryable, attempt);

      await step.run(`record-failure-${index}`, async () => {
        await updateRenderRow(renderRow.id, { status: 'failed', error: outcome.error });
        // Back to `storyboarded`, not `failed`: the shots are all still good, it
        // is only the assembly that did not land, and the timeline is intact.
        if (!canRetry) {
          await db()
            .update(episodes)
            .set({ status: 'storyboarded' })
            .where(eq(episodes.id, episodeId));
        }
        return { recorded: true };
      });

      if (canRetry) {
        await step.sendEvent('retry', {
          id: `episode-render:${episodeId}:${attempt + 1}`,
          name: 'episode/render.requested',
          data: { userId, episodeId, attempt: attempt + 1 },
        });
        return { episodeId, status: 'retrying' as const, attempt };
      }

      return { episodeId, status: 'failed' as const, attempt, error: outcome.error };
    }

    /* -- 5. Timeout -------------------------------------------------------- */

    const timeoutMessage =
      'The render did not finish within 15 minutes. Retry it — the timeline is unchanged.';

    await step.run('timeout', async () => {
      await updateRenderRow(renderRow.id, { status: 'failed', error: timeoutMessage });
      await db()
        .update(episodes)
        .set({ status: 'storyboarded' })
        .where(eq(episodes.id, episodeId));
      return { timedOut: true };
    });

    log.error('render timed out', { ...context, operation: 'render.timeout' });
    return { episodeId, status: 'failed' as const, attempt, error: timeoutMessage };
  },
);
