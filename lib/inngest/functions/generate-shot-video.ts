import { NonRetriableError } from 'inngest';
import { screenWithRules } from '@/lib/ai/safety';
import {
  claimVideoSlot,
  loadShotForJob,
  reconcileShotStatus,
  recordedProviderJobId,
  setShotStatus,
  updateAsset,
  upsertAsset,
} from '@/lib/data/generation';
import { log } from '@/lib/log';
import { getVideoProvider, ProviderRequestError } from '@/lib/providers';
import { assertWithinSpendCap, SpendCapError } from '@/lib/spend';
import { clipPath, ingestFromUrl } from '@/lib/storage';
import { recordUsage } from '@/lib/usage';
import { inngest, shotVideoEventId } from '../client';
import { pollSchedule, toSleepDuration } from '../backoff';

/**
 * How long to wait before trying again for an in-flight slot.
 *
 * Backs off from one second rather than sitting at a flat interval. A fixed 10s
 * wait quantised the whole queue to ten-second steps: with three slots and seven
 * shots, the tail shots idled through a full interval each even though a slot had
 * freed almost immediately, adding about a minute to a run that should take
 * forty seconds. Short waits early keep a fast provider moving; the ceiling stops
 * a slow one from hammering the database for an hour.
 */
function admissionWait(attempt: number): string {
  return `${Math.min(10, 2 ** attempt)}s`;
}

/**
 * Give up after this many waits.
 *
 * The schedule above sums to roughly 20 minutes, matching
 * `VIDEO_SLOT_LEASE_MINUTES` — so a shot only fails for want of a slot once every
 * stale lease it could have been waiting on has expired, i.e. only when the queue
 * is genuinely busy, never because of a crashed sibling.
 */
const MAX_ADMISSION_WAITS = 125;
import { shouldRetry } from '../retry';

/**
 * Generates one video clip for one shot.
 *
 * Every external interaction is its own `step.run`, so Inngest records each
 * result durably and a restart resumes from the last completed step rather than
 * from the beginning (Phase 3 AC #2).
 *
 * Step granularity alone was not enough, though. Durability also needs Inngest to
 * be *allowed* to retry a step whose execution failed, which `retries: 0`
 * forbade — see the note on `retries` below. Two distinct retry policies are in
 * play here and they must not be confused:
 *
 * - **Provider outcomes** — a clip that the provider reports as failed. Owned by
 *   the loop in this function, capped at two attempts, and distinguishing
 *   retryable from non-retryable per the spec. These never throw.
 * - **Step execution** — a crash, a deploy, a dropped connection. Owned by
 *   Inngest, because only Inngest can re-invoke a process that has gone away.
 *
 * The provider is charged at most once per attempt: `submit` adopts a job id
 * already recorded for the asset instead of buying a second one.
 */

export const generateShotVideo = inngest.createFunction(
  {
    id: 'shot-generate-video',
    name: 'Generate shot video',
    // Phase 3 AC #4. Keyed on the user, so one person's 20-shot episode cannot
    // starve anyone else, and their own jobs queue behind three in flight.
    concurrency: { limit: 3, key: 'event.data.userId' },
    /**
     * Inngest retries *step execution*; our loop below owns *provider outcomes*.
     * These are separate concerns and conflating them broke durability.
     *
     * This was `retries: 0`, on the reasoning that "our own logic owns retries".
     * But a provider failure never throws — the poll step catches it and returns
     * `{ ok: false, retryable }`, and the loop decides what to do. The only thing
     * that actually throws out of a step is infrastructure: a crash, a deploy, a
     * restart, a dropped connection. With `retries: 0` the first such throw
     * killed the run permanently.
     *
     * Restarting the dev server mid-generation therefore stranded the episode:
     * 10 of 20 shots ready, 6 stuck at `generating`, and no further progress
     * after ten minutes — Inngest never re-invoked the functions at all. Raising
     * this cannot multiply provider retries, because provider failures do not
     * reach it.
     */
    retries: 3,
  },
  { event: 'shot/video.requested' },
  async ({ event, step }) => {
    const { userId, episodeId, shotId, attempt } = event.data;
    const provider = getVideoProvider();
    const context = { userId, episodeId, shotId, provider: provider.id, attempt };

    /* -- 1. What are we generating? ---------------------------------------- */

    const plan = await step.run('load-shot', async () => {
      const { shot, series } = await loadShotForJob(shotId, userId);

      // Already done — a duplicate event, or a resumed run past this point.
      if (shot.status === 'ready') return null;

      const prompt = shot.promptOverride ?? shot.videoPrompt;
      if (!prompt?.trim()) {
        throw new NonRetriableError(
          'This shot has no video prompt. Regenerate the storyboard for this episode.',
        );
      }

      // Cross-cutting content gate. Rules only: the premise and bible were
      // screened by the model at creation, and this runs per shot, so it has to
      // be free and deterministic.
      const findings = screenWithRules(`${prompt} ${shot.action} ${shot.dialogue ?? ''}`);
      if (findings.length > 0) {
        throw new NonRetriableError(findings[0]!.message);
      }

      return {
        prompt,
        negativePrompt: shot.negativePrompt,
        durationSeconds: shot.durationSeconds,
        seriesId: series.id,
        estimateCents: provider.estimateCostCents({
          prompt,
          durationSeconds: shot.durationSeconds,
          aspectRatio: '9:16',
        }),
      };
    });

    if (!plan) {
      log.info('shot already generated', { ...context, operation: 'video.skip' });
      return { skipped: true as const, reason: 'already ready' };
    }

    /* -- 2. Can they afford it? -------------------------------------------- */

    // The episode-level guard already ran, but a concurrent episode can move the
    // number underneath us between enqueue and execution.
    await step.run('spend-guard', async () => {
      try {
        await assertWithinSpendCap(userId, plan.estimateCents);
      } catch (error) {
        if (error instanceof SpendCapError) {
          await setShotStatus(shotId, 'failed');
          throw new NonRetriableError(error.message);
        }
        throw error;
      }
      return { ok: true };
    });

    /* -- 3. Submit ---------------------------------------------------------- */

    const asset = await step.run('create-asset', async () => {
      const row = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: provider.id,
        attempt,
      });
      await setShotStatus(shotId, 'queued', { retryCount: attempt });
      return { id: row.id };
    });

    /* -- 3a. Admission control ---------------------------------------------- */

    /**
     * Wait for a free in-flight slot before spending anything.
     *
     * The `concurrency` option above is necessary but not sufficient: it bounds
     * step execution, and every `step.sleep` in the poll loop below hands the
     * slot back, so a 20-shot episode submitted all 20 clips to the provider
     * before the first one finished. This loop is the bound that actually holds,
     * and because it sits *before* `submit`, an episode that has to queue costs
     * nothing while it waits.
     */
    const admitted = await (async () => {
      for (let wait = 0; wait <= MAX_ADMISSION_WAITS; wait++) {
        if (await step.run(`admit-${wait}`, () => claimVideoSlot(userId, asset.id))) return true;
        await step.sleep(`admission-wait-${wait}`, admissionWait(wait));
      }
      return false;
    })();

    if (!admitted) {
      await step.run('admission-timeout', async () => {
        await updateAsset(asset.id, {
          status: 'failed',
          error: 'Waited too long for a free generation slot. Try this shot again.',
        });
        await reconcileShotStatus(shotId);
        log.warn('video job never got a slot', { ...context, operation: 'video.admission.timeout' });
      });
      return { shotId, status: 'failed' as const, attempt, error: 'no slot' };
    }

    const submitted = await step.run('submit', async () => {
      const started = Date.now();

      // If a previous execution of this step already got a job accepted, adopt it
      // instead of buying a second one. Only reachable when the step threw before
      // it could return — i.e. a crash or a restart.
      const existing = await recordedProviderJobId(asset.id);
      if (existing) {
        log.info('adopting a job submitted before the interruption', {
          ...context,
          operation: 'video.submit.resumed',
          providerJobId: existing,
        });
        return { providerJobId: existing };
      }

      let providerJobId: string;
      try {
        ({ providerJobId } = await provider.generate({
          prompt: plan.prompt,
          ...(plan.negativePrompt ? { negativePrompt: plan.negativePrompt } : {}),
          durationSeconds: plan.durationSeconds,
          aspectRatio: '9:16',
        }));
      } catch (error) {
        /**
         * A refusal the provider will repeat — no credit, a revoked token, a
         * model slug that does not exist. Retrying spends four attempts to reach
         * the same place, so stop here and put the reason where the reviewer
         * reads it. Anything else falls through to Inngest's retry policy.
         */
        if (error instanceof ProviderRequestError && !error.retryable) {
          await updateAsset(asset.id, { status: 'failed', error: error.message });
          await reconcileShotStatus(shotId);
          log.error('video submit refused permanently', {
            ...context,
            operation: 'video.submit.refused',
            status: error.status,
            error: error.message,
          });
          throw new NonRetriableError(error.message);
        }
        throw error;
      }

      await updateAsset(asset.id, { providerJobId, status: 'generating' });
      await setShotStatus(shotId, 'generating');

      log.info('video job submitted', {
        ...context,
        operation: 'video.submit',
        durationMs: Date.now() - started,
        providerJobId,
      });

      return { providerJobId };
    });

    /* -- 4. Poll ------------------------------------------------------------ */

    const delays = pollSchedule();

    for (const [index, delay] of delays.entries()) {
      await step.sleep(`wait-${index}`, toSleepDuration(delay));

      const outcome = await step.run(`poll-${index}`, async () => {
        const result = await provider.poll(submitted.providerJobId);

        if (result.status === 'pending') return { done: false as const };

        if (result.status === 'failed') {
          log.warn('video job failed', {
            ...context,
            operation: 'video.poll',
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

        // Ready: pull the file across before anything else, so a storage failure
        // does not leave a "ready" shot pointing at a URL that will expire.
        const stored = await ingestFromUrl({
          url: result.url,
          bucket: 'clips',
          path: clipPath({ userId, episodeId, shotId, attempt }),
        });

        await updateAsset(asset.id, {
          status: 'ready',
          storagePath: stored.storagePath,
          durationSeconds: plan.durationSeconds,
          costCents: result.costCents,
          error: null,
          meta: { attempt, ai_generated: true, bytes: stored.bytes, ...(result.meta ?? {}) },
        });

        // Real cost, from the provider — not the estimate.
        await recordUsage({
          userId,
          seriesId: plan.seriesId,
          episodeId,
          provider: provider.id,
          operation: 'video.generate',
          costCents: result.costCents,
          // One charge per shot per attempt, however many times this step runs.
          idempotencyKey: `video.generate:${shotId}:${attempt}`,
        });

        // Not `setShotStatus(shotId, 'ready')`: a shot with dialogue is not ready
        // until its voice has landed too, and this job knows nothing about its
        // sibling. Let the assets decide.
        const shotStatus = await reconcileShotStatus(shotId);

        log.info('video job ready', {
          ...context,
          operation: 'video.ready',
          costCents: result.costCents,
        });

        return { done: true as const, ok: true as const, costCents: result.costCents, shotStatus };
      });

      if (!outcome.done) continue;

      if (outcome.ok) {
        // The video is done; `shotStatus` is the *shot's* state, which stays
        // `generating` until a sibling voice job lands.
        return { shotId, status: outcome.shotStatus, costCents: outcome.costCents, attempt };
      }

      /* -- 5. Failure: retry, or stop ------------------------------------- */

      const canRetry = shouldRetry(outcome.retryable, attempt);

      await step.run(`record-failure-${index}`, async () => {
        await updateAsset(asset.id, { status: 'failed', error: outcome.error });
        // Stay 'generating' while a retry is in flight so the UI does not flash
        // a failure the user cannot act on.
        await setShotStatus(shotId, canRetry ? 'generating' : 'failed', { retryCount: attempt });
        return { recorded: true };
      });

      if (canRetry) {
        await step.sendEvent('retry', {
          id: shotVideoEventId(shotId, attempt + 1),
          name: 'shot/video.requested',
          data: { userId, episodeId, shotId, attempt: attempt + 1 },
        });
        return { shotId, status: 'retrying' as const, attempt, nextAttempt: attempt + 1 };
      }

      return {
        shotId,
        status: 'failed' as const,
        attempt,
        error: outcome.error,
        retryable: outcome.retryable,
      };
    }

    /* -- 6. Ran out of patience -------------------------------------------- */

    const timeoutMessage =
      'The provider did not finish within 15 minutes. The job may still be running on their ' +
      'side — retry this shot to start a fresh one.';

    await step.run('timeout', async () => {
      await updateAsset(asset.id, { status: 'failed', error: timeoutMessage });
      await setShotStatus(shotId, 'failed', { retryCount: attempt });
      return { timedOut: true };
    });

    log.error('video job timed out', { ...context, operation: 'video.timeout' });
    return { shotId, status: 'failed' as const, attempt, error: timeoutMessage };
  },
);
