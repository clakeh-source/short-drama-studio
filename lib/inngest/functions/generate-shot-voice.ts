import { NonRetriableError } from 'inngest';
import {
  loadShotForJob,
  reconcileShotStatus,
  updateAsset,
  upsertAsset,
} from '@/lib/data/generation';
import { log } from '@/lib/log';
import { getTtsProvider, ProviderRequestError } from '@/lib/providers';
import { assertWithinSpendCap, SpendCapError } from '@/lib/spend';
import { uploadBuffer, voicePath } from '@/lib/storage';
import { recordUsage } from '@/lib/usage';
import { inngest } from '../client';
import { shouldRetry } from '../retry';
import { VOICE_HEADROOM_SECONDS, voiceOverruns } from '@/lib/shots';

/**
 * Synthesises the voiceover for one shot's line.
 *
 * TTS is synchronous — the provider returns bytes, so there is no polling. The
 * measured duration is stored as returned, never rounded to fit the shot: if the
 * line runs longer than the clip, that is a real problem the editor has to see
 * and decide about (Phase 3 AC #7), not something to paper over by truncating
 * the audio.
 */

// Both live in `lib/shots.ts` now — the data layer needs them too and cannot
// import from here without a cycle. Re-exported so existing importers still work.
export { VOICE_HEADROOM_SECONDS, voiceOverruns };

export const generateShotVoice = inngest.createFunction(
  {
    id: 'shot-generate-voice',
    name: 'Generate shot voiceover',
    // TTS is cheap and fast next to video, but still per-user so one account
    // cannot saturate the provider.
    concurrency: { limit: 5, key: 'event.data.userId' },
    // As in the video function: Inngest retries step *execution*, the code below
    // owns provider outcomes. A TTS failure is caught and returned, never thrown,
    // so this only ever retries a crash or a restart. See the note there.
    retries: 3,
  },
  { event: 'shot/voice.requested' },
  async ({ event, step }) => {
    const { userId, episodeId, shotId, attempt } = event.data;
    const provider = getTtsProvider();
    const context = { userId, episodeId, shotId, provider: provider.id, attempt };

    const plan = await step.run('load-shot', async () => {
      const { shot, series, speaker } = await loadShotForJob(shotId, userId);

      const dialogue = shot.dialogue?.trim();
      if (!dialogue) return null;

      /**
       * A misconfiguration, not an outage — retrying cannot fix it. Record it on
       * a failed voice asset before throwing, so the shot reconciles to `failed`
       * and the reviewer reads the reason in the UI. Throwing bare left the shot
       * sitting in `generating` with nothing to explain it, which looked like a
       * hung job rather than a question the human needs to answer.
       */
      const refuse = async (message: string): Promise<never> => {
        const row = await upsertAsset({
          shotId,
          episodeId,
          kind: 'voice',
          provider: provider.id,
          attempt,
        });
        await updateAsset(row.id, { status: 'failed', error: message });
        await reconcileShotStatus(shotId);
        log.warn('voice not configured', {
          ...context,
          operation: 'voice.unconfigured',
          error: message,
        });
        throw new NonRetriableError(message);
      };

      // `return refuse(...)` rather than `await`: returning a `never` is what
      // lets the compiler narrow `speaker` past these guards.
      if (!speaker) {
        return refuse(
          'This shot has dialogue but no speaker. Pick who says the line on the storyboard.',
        );
      }
      if (!speaker.voiceId) {
        return refuse(`${speaker.name} has no voice assigned yet. Choose one on the series page.`);
      }

      return {
        dialogue,
        voiceId: speaker.voiceId,
        speakerName: speaker.name,
        shotSeconds: shot.durationSeconds,
        seriesId: series.id,
        estimateCents: provider.estimateCostCents(dialogue),
      };
    });

    if (!plan) {
      return { skipped: true as const, reason: 'no dialogue' };
    }

    await step.run('spend-guard', async () => {
      try {
        await assertWithinSpendCap(userId, plan.estimateCents);
      } catch (error) {
        if (error instanceof SpendCapError) throw new NonRetriableError(error.message);
        throw error;
      }
      return { ok: true };
    });

    const asset = await step.run('create-asset', async () => {
      const row = await upsertAsset({
        shotId,
        episodeId,
        kind: 'voice',
        provider: provider.id,
        attempt,
      });
      return { id: row.id };
    });

    const result = await step.run('synthesize', async () => {
      const started = Date.now();

      try {
        const { audio, durationSeconds, words } = await provider.synthesize({
          text: plan.dialogue,
          voiceId: plan.voiceId,
        });

        const stored = await uploadBuffer({
          bucket: 'audio',
          path: voicePath({ userId, episodeId, shotId, attempt }),
          buffer: audio,
          contentType: 'audio/wav',
        });

        const costCents = provider.estimateCostCents(plan.dialogue);
        const overruns = voiceOverruns(durationSeconds, plan.shotSeconds);

        await updateAsset(asset.id, {
          status: 'ready',
          storagePath: stored.storagePath,
          // Stored as measured. The UI compares it against the shot length.
          durationSeconds: Math.ceil(durationSeconds),
          costCents,
          error: null,
          meta: {
            attempt,
            ai_generated: true,
            speaker: plan.speakerName,
            measuredSeconds: durationSeconds,
            shotSeconds: plan.shotSeconds,
            overruns,
            bytes: stored.bytes,
            /**
             * Per-word alignment, when the provider measured it. `lib/data/render.ts`
             * reads it back out of here and `lib/timeline.ts` prefers it over its
             * length-proportional approximation, so captions land on the word
             * actually being spoken. Omitted rather than stored empty: the
             * timeline treats an empty array as "no alignment" anyway, and a
             * missing key says the same thing without the row growing.
             */
            ...(words?.length ? { words } : {}),
          },
        });

        await recordUsage({
          userId,
          seriesId: plan.seriesId,
          episodeId,
          provider: provider.id,
          operation: 'voice.synthesize',
          costCents,
          // One charge per shot per attempt, however many times this step runs.
          idempotencyKey: `voice.synthesize:${shotId}:${attempt}`,
        });

        log.info('voice ready', {
          ...context,
          operation: 'voice.ready',
          durationMs: Date.now() - started,
          costCents,
          overruns,
        });

        return { ok: true as const, durationSeconds, overruns, costCents };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A provider that refused outright says whether trying again could help.
        // Anything else keeps the old assumption that TTS failures are transient.
        const retryable = error instanceof ProviderRequestError ? error.retryable : true;
        await updateAsset(asset.id, { status: 'failed', error: message });
        log.error('voice failed', {
          ...context,
          operation: 'voice.failed',
          error: message,
          retryable,
        });
        return { ok: false as const, error: message, retryable };
      }
    });

    if (result.ok) {
      // The voice landed, but the shot is only ready once its video has too.
      const shotStatus = await step.run('reconcile', () => reconcileShotStatus(shotId));
      return {
        shotId,
        status: shotStatus,
        durationSeconds: result.durationSeconds,
        overruns: result.overruns,
      };
    }

    // TTS failures are transient far more often than not, so an unclassified one
    // is still treated as retryable — but a provider that told us it will refuse
    // again (a missing voice, an exhausted quota) is taken at its word.
    if (shouldRetry(result.retryable ?? true, attempt)) {
      await step.sendEvent('retry', {
        id: `shot-voice:${shotId}:${attempt + 1}`,
        name: 'shot/voice.requested',
        data: { userId, episodeId, shotId, attempt: attempt + 1 },
      });
      return { shotId, status: 'retrying' as const, attempt };
    }

    // Out of retries. Surface it on the shot: a missing line is a defect the
    // reviewer has to see, not something to leave looking green.
    await step.run('reconcile-failed', () => reconcileShotStatus(shotId));

    return { shotId, status: 'failed' as const, attempt, error: result.error };
  },
);
