import { NonRetriableError } from 'inngest';
import { screenWithRules } from '@/lib/ai/safety';
import { buildShotKeyframe, KEYFRAME_URL_TTL_SECONDS } from '@/lib/characters/keyframe';
import { loadShotReferenceSet } from '@/lib/characters/reference-set';
import { pinnedShotKeyframe } from '@/lib/assets/reuse';
import {
  claimVideoSlot,
  MAX_INFLIGHT_VIDEO_JOBS,
  loadShotForJob,
  reconcileShotStatus,
  recordedProviderJobId,
  setShotStatus,
  updateAsset,
  upsertAsset,
} from '@/lib/data/generation';
import { log } from '@/lib/log';
import { getImageProvider, getVideoProvider, ProviderRequestError } from '@/lib/providers';
import { assertWithinSpendCap, SpendCapError } from '@/lib/spend';
import { clipPath, ingestFromUrl, signedUrl } from '@/lib/storage';
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
    /**
     * In-flight video jobs per *project*, from the one place that defines it.
     *
     * Declared at the queue rather than enforced by an app-level semaphore, per
     * the spec. It is necessary but not sufficient on its own — every
     * `step.sleep` in the poll loop below hands the slot back, so this bounds
     * concurrent *execution*, not concurrent provider jobs. `claimVideoSlot`
     * is the lease that makes the cap hold across sleeps; see its comment.
     *
     * Both read `MAX_INFLIGHT_VIDEO_JOBS`, so raising `VIDEO_CONCURRENCY` moves
     * them together. Two different numbers here would mean the queue admitted
     * work the lease then refused, and shots would sit in admission-wait for no
     * reason.
     */
    concurrency: { limit: MAX_INFLIGHT_VIDEO_JOBS, key: 'event.data.seriesId' },
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
    const { userId, seriesId, episodeId, shotId, attempt, version } = event.data;
    const provider = getVideoProvider();
    const context = { userId, seriesId, episodeId, shotId, provider: provider.id, attempt, version };

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

      /**
       * The canonical stills of everyone in this shot.
       *
       * Loaded here, in the same durable step as the rest of the plan, so a
       * resumed run re-uses the URLs it already signed rather than minting new
       * ones — and so what the job conditioned on is recorded even if the
       * character's reference set changes underneath it later.
       */
      const references = await loadShotReferenceSet(shot.characterIds);

      /**
       * A start frame drawn for *this shot*, not a portrait of one of its
       * characters.
       *
       * The video model conditions on a single image. Sending a studio portrait
       * meant a two-hander only ever preserved the first-billed face, and every
       * clip opened on a grey backdrop it had to travel out of. A keyframe of
       * the actual composition fixes both, and falls back to the portraits when
       * it cannot be drawn.
       */
      /**
       * A frame someone pinned from the Assets library wins over drawing one.
       *
       * They looked at it and chose it, which is better information than
       * anything this job has — and it saves the image the keyframe would have
       * cost. Checked before `buildShotKeyframe` so nothing is spent finding
       * out it was not needed.
       */
      const pinned = await pinnedShotKeyframe(shotId);
      const pinnedUrl = pinned ? await signedUrl(pinned.storagePath, KEYFRAME_URL_TTL_SECONDS) : null;

      const keyframe = pinnedUrl
        ? null
        : await buildShotKeyframe({
            userId,
            episodeId,
            shotId,
            version,
            prompt,
            negativePrompt: shot.negativePrompt,
            references,
          });

      if (pinned && !pinnedUrl) {
        // The row is there and the object is not, or signing failed. Say so —
        // the shot is about to be generated *without* the frame someone
        // deliberately chose, and silently ignoring that choice is worse than
        // the extra 5c of drawing one.
        log.warn('a pinned start frame could not be signed; drawing one instead', {
          ...context,
          operation: 'shot.keyframe.pinned_unavailable',
          storagePath: pinned.storagePath,
        });
      }

      /**
       * The keyframe is an asset and is booked like one.
       *
       * It is stored, it cost money, and the spend ledger is reconciled against
       * `assets.cost_cents` — so recording the charge without a row to hang it
       * on would break that invariant, and recording neither would quietly
       * understate what a film costs by one image per shot.
       */
      if (keyframe) {
        const row = await upsertAsset({
          shotId,
          episodeId,
          kind: 'image',
          provider: getImageProvider().id,
          attempt,
          version,
        });

        await updateAsset(row.id, {
          status: 'ready',
          storagePath: keyframe.storagePath,
          costCents: keyframe.costCents,
          meta: {
            attempt,
            version,
            ai_generated: true,
            role: 'keyframe',
            facesUsed: keyframe.facesUsed,
            facesRequested: keyframe.facesRequested,
            bytes: keyframe.bytes,
          },
        });

        await recordUsage({
          userId,
          seriesId: series.id,
          episodeId,
          provider: getImageProvider().id,
          operation: 'shot.keyframe',
          costCents: keyframe.costCents,
          idempotencyKey: `shot.keyframe:${shotId}:v${version}:${attempt}`,
        });
      }

      return {
        prompt,
        negativePrompt: shot.negativePrompt,
        durationSeconds: shot.durationSeconds,
        seriesId: series.id,
        // The keyframe supersedes the portraits when there is one: it already
        // contains the characters, in the right place, at the right size.
        /**
         * Precedence: a pinned frame, then a drawn one, then the portraits.
         * The pin is a decision someone made; the keyframe is this job's best
         * guess; the portraits are the fallback from before either existed.
         */
        referenceImageUrls: pinnedUrl
          ? [pinnedUrl]
          : keyframe
            ? [keyframe.url]
            : references.urls,
        pinnedKeyframe: pinnedUrl ? { storagePath: pinned!.storagePath } : null,
        keyframe,
        referenceCharacters: references.characters,
        /**
         * The cast, grouped, for a model that can hold more than one identity.
         *
         * Sent alongside the keyframe rather than instead of it: the keyframe
         * establishes the location and the framing, and the elements establish
         * who is in it. Adapters whose model reads neither ignore this.
         */
        castReferences: references.characters.map((character) => ({
          name: character.name,
          urls: character.urls,
        })),
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
        version,
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
        if (await step.run(`admit-${wait}`, () => claimVideoSlot(plan.seriesId, asset.id)))
          return true;
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
          providerJobId: existing.providerJobId,
        });
        return { providerJobId: existing.providerJobId, providerMeta: existing.meta };
      }

      /**
       * Reference stills present means image-to-video; none means
       * text-to-video. The adapter makes that choice, but the decision is
       * recorded here — on the asset and in the log — because "did this shot
       * actually condition on the character's face" is otherwise unanswerable
       * after the fact, and a silent fallback to text-to-video looks exactly
       * like a working pipeline until you notice the face changed.
       */
      const mode = plan.referenceImageUrls.length > 0 ? 'image-to-video' : 'text-to-video';

      let providerJobId: string;
      let providerMeta: Record<string, unknown> | undefined;
      try {
        ({ providerJobId, meta: providerMeta } = await provider.generate({
          prompt: plan.prompt,
          ...(plan.negativePrompt ? { negativePrompt: plan.negativePrompt } : {}),
          durationSeconds: plan.durationSeconds,
          aspectRatio: '9:16',
          ...(plan.referenceImageUrls.length > 0
            ? { referenceImageUrls: plan.referenceImageUrls }
            : {}),
          ...(plan.castReferences.length > 0 ? { castReferences: plan.castReferences } : {}),
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

      await updateAsset(asset.id, {
        providerJobId,
        status: 'generating',
        meta: {
          attempt,
          version,
          ai_generated: true,
          // The evidence for AC #1, kept where a reviewer can read it back off
          // the row months later rather than only in a log that has rotated.
          mode,
          referenceImageCount: plan.referenceImageUrls.length,
          referenceCharacters: plan.referenceCharacters,
          /**
           * What the clip was actually conditioned on. `facesUsed` is the
           * honest number — a two-hander drawn by a single-identity model
           * conditions on one face and the other character comes from the
           * prompt, and that is worth being able to read off the row.
           */
          /**
           * The keyframe's own numbers describe the *frame*: how many of the
           * shot's characters the start image managed to show. They are no
           * longer the answer to "did the two-hander hold" — the clip's
           * identities come from the cast below.
           */
          keyframe: plan.keyframe
            ? {
                storagePath: plan.keyframe.storagePath,
                facesUsed: plan.keyframe.facesUsed,
                facesRequested: plan.keyframe.facesRequested,
                costCents: plan.keyframe.costCents,
              }
            : null,
          /**
           * What the *clip* was conditioned on, from the adapter that sent it:
           * `elementsUsed` against `castRequested`, and any name the prompt
           * never used. A gap between the two is a shot where somebody was
           * described rather than held, which is the failure this whole path
           * exists to remove and is otherwise invisible until the faces change.
           */
          ...(providerMeta ?? {}),
        },
      });
      await setShotStatus(shotId, 'generating');

      /**
       * A cast the model cannot hold is worth a warning, not a failure.
       *
       * The clip still renders and still looks plausible; the faces drift.
       * Usually a pre-v3 model pinned in the environment, which reads as a
       * working pipeline right up until someone watches two shots in a row.
       */
      const elementsUsed = Number(providerMeta?.elementsUsed ?? 0);
      if (plan.castReferences.length > 0 && elementsUsed < plan.castReferences.length) {
        log.warn('some of this shot’s cast is described rather than held', {
          ...context,
          operation: 'video.cast.partial',
          castRequested: plan.castReferences.length,
          elementsUsed,
          castCapacity: provider.castCapacity,
          ...(providerMeta?.castIntroduced ? { castIntroduced: providerMeta.castIntroduced } : {}),
        });
      }

      log.info('video job submitted', {
        ...context,
        operation: 'video.submit',
        durationMs: Date.now() - started,
        providerJobId,
        mode,
        referenceImageCount: plan.referenceImageUrls.length,
        referenceCharacters: plan.referenceCharacters.map((c) => c.name),
      });

      // `providerMeta` travels out of the step, not just into the row: the poll
      // below rewrites `meta` wholesale on success, and this is the only place
      // that knows what the request actually carried.
      return { providerJobId, providerMeta: providerMeta ?? {} };
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
          path: clipPath({ userId, episodeId, shotId, version, attempt }),
        });

        await updateAsset(asset.id, {
          status: 'ready',
          storagePath: stored.storagePath,
          durationSeconds: plan.durationSeconds,
          costCents: result.costCents,
          error: null,
          meta: {
            attempt,
            version,
            ai_generated: true,
            mode: plan.referenceImageUrls.length > 0 ? 'image-to-video' : 'text-to-video',
            referenceImageCount: plan.referenceImageUrls.length,
            referenceCharacters: plan.referenceCharacters,
            keyframe: plan.keyframe
              ? {
                  storagePath: plan.keyframe.storagePath,
                  facesUsed: plan.keyframe.facesUsed,
                  facesRequested: plan.keyframe.facesRequested,
                }
              : null,
            // Carried across from the submit step: `meta` is replaced, not
            // merged, so a finished clip would otherwise be the one row that
            // no longer records what it was conditioned on.
            ...submitted.providerMeta,
            bytes: stored.bytes,
            ...(result.meta ?? {}),
          },
        });

        // Real cost, from the provider — not the estimate.
        await recordUsage({
          userId,
          seriesId: plan.seriesId,
          episodeId,
          provider: provider.id,
          operation: 'video.generate',
          costCents: result.costCents,
          // One charge per shot per take per attempt, however many times this
          // step runs. The version is part of the key because a regeneration is
          // a genuinely new charge, not a repeat of the old one.
          idempotencyKey: `video.generate:${shotId}:v${version}:${attempt}`,
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
          id: shotVideoEventId(shotId, attempt + 1, version),
          name: 'shot/video.requested',
          // Same version: a retry is another go at *this* take, so it overwrites
          // rather than adding to the history the user can revert through.
          data: { userId, seriesId, episodeId, shotId, attempt: attempt + 1, version },
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
