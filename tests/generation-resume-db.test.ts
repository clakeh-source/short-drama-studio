import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { assets, episodes, scenes, series, shots } from '@/lib/db/schema';
import {
  reconcileShotStatus,
  recordedProviderJobId,
  updateAsset,
  upsertAsset,
} from '@/lib/data/generation';
import { decodeJobId, encodeJobId, FalVideoProvider } from '@/lib/providers/fal/video';
import { MAX_AUTOMATIC_RETRIES, maxProviderCalls, shouldRetry } from '@/lib/inngest/retry';

/**
 * Phase 4 AC #3 and AC #4 — surviving a restart, and giving up correctly.
 *
 * Both are properties of what is *written down*. A worker that keeps a job
 * handle in memory looks identical to one that persists it right up until the
 * process dies, and a retry policy that never records its last error looks
 * identical to one that does right up until someone asks why a shot failed. So
 * these assert the rows, not the control flow.
 *
 * Requires DATABASE_URL and `pnpm db:migrate`.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

const userId = crypto.randomUUID();
let episodeId: string;
let shotId: string;

async function freshShot(): Promise<void> {
  await db().delete(series).where(eq(series.userId, userId));

  const [s] = await db()
    .insert(series)
    .values({ userId, title: 'Resume: The Last Ferry', logline: '' })
    .returning({ id: series.id });

  const [ep] = await db()
    .insert(episodes)
    .values({ seriesId: s!.id, number: 1 })
    .returning({ id: episodes.id });
  episodeId = ep!.id;

  const [sc] = await db()
    .insert(scenes)
    .values({ episodeId, orderIndex: 0, location: 'Terminal', timeOfDay: 'night' })
    .returning({ id: scenes.id });

  const [shot] = await db()
    .insert(shots)
    .values({
      sceneId: sc!.id,
      orderIndex: 0,
      durationSeconds: 5,
      videoPrompt: 'A medium shot.',
    })
    .returning({ id: shots.id });
  shotId = shot!.id;
}

describe.skipIf(!hasDatabase)('surviving a restart and failing cleanly', () => {
  beforeEach(freshShot);

  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  describe('AC #3 — a restarted worker resumes the job it already started', () => {
    it('finds the in-flight job on the row, not in memory', async () => {
      const asset = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 0,
        version: 1,
      });

      const jobId = encodeJobId('fal-ai/kling-video/v3/pro/image-to-video', 10, 'req-restart');
      await updateAsset(asset.id, { providerJobId: jobId, status: 'generating' });

      // Everything the process knew is now gone. A fresh read of the row is all
      // a restarted worker has, and it has to be enough.
      const recovered = await recordedProviderJobId(asset.id);
      expect(recovered?.providerJobId).toBe(jobId);

      // And it is enough: the id alone says which model to poll and how long the
      // clip is, so a brand-new provider instance can finish the job.
      const decoded = decodeJobId(recovered!.providerJobId);
      expect(decoded.requestId).toBe('req-restart');
      expect(decoded.model).toBe('fal-ai/kling-video/v3/pro/image-to-video');
      expect(decoded.durationSeconds).toBe(10);
      expect(new FalVideoProvider().id).toBe('fal');
    });

    it('adopts the existing job rather than buying a second one', async () => {
      const first = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 0,
        version: 1,
      });
      await updateAsset(first.id, { providerJobId: 'model#5#req-1', status: 'generating' });

      // The submit step re-running after a crash: same shot, same take, same
      // attempt. It must resolve to the same row, or the shot is charged twice.
      const second = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 0,
        version: 1,
      });

      expect(second.id).toBe(first.id);

      const adopted = await recordedProviderJobId(second.id);
      expect(adopted?.providerJobId).toBe('model#5#req-1');
      // The meta comes back with it: a resumed job that adopted a submission
      // but forgot what that submission carried would overwrite the record
      // with silence when the clip finally lands.
      expect(adopted?.meta).toBeDefined();
    });

    it('has nothing to adopt before a job has been accepted', async () => {
      const asset = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 0,
        version: 1,
      });

      // The distinction that keeps a crashed submit from being skipped.
      expect(await recordedProviderJobId(asset.id)).toBeNull();
    });
  });

  describe('AC #4 — a failing provider ends failed, with the reason kept', () => {
    it('retries a retryable failure up to the cap and no further', () => {
      expect(shouldRetry(true, 0)).toBe(true);
      expect(shouldRetry(true, MAX_AUTOMATIC_RETRIES - 1)).toBe(true);
      // The attempt that exhausts the budget does not schedule another.
      expect(shouldRetry(true, MAX_AUTOMATIC_RETRIES)).toBe(false);
      expect(maxProviderCalls()).toBe(3);
    });

    it('never retries a refusal, however early', () => {
      // A 402 answers the same way three times; the flag is what stops the
      // worker spending three attempts to find that out.
      expect(shouldRetry(false, 0)).toBe(false);
    });

    it('leaves the shot failed with the last error on the asset', async () => {
      const errors = ['fal 500: upstream error', 'fal 500: upstream error', 'fal 500: still down'];

      for (const [attempt, error] of errors.entries()) {
        const asset = await upsertAsset({
          shotId,
          episodeId,
          kind: 'video',
          provider: 'fal',
          attempt,
          version: 1,
        });
        await updateAsset(asset.id, { status: 'failed', error });
      }

      // Three provider calls, three rows, and then it stops.
      const rows = await db().select().from(assets).where(eq(assets.shotId, shotId));
      expect(rows).toHaveLength(maxProviderCalls());
      expect(shouldRetry(true, errors.length - 1)).toBe(false);

      expect(await reconcileShotStatus(shotId)).toBe('failed');

      const [shot] = await db().select().from(shots).where(eq(shots.id, shotId));
      expect(shot!.status).toBe('failed');

      // The message survives, on the last attempt's row. A failed shot with no
      // reason on it is a support ticket nobody can answer.
      const last = rows.find(
        (r) => (r.meta as { attempt?: number } | null)?.attempt === errors.length - 1,
      );
      expect(last!.error).toBe('fal 500: still down');
    });

    it('a later success supersedes the earlier failures', async () => {
      const failed = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 0,
        version: 1,
      });
      await updateAsset(failed.id, { status: 'failed', error: 'transient' });

      const retried = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'fal',
        attempt: 1,
        version: 1,
      });
      await updateAsset(retried.id, { status: 'ready', storagePath: 'clips/x.mp4' });

      // A kind counts as ready if any of its attempts is; otherwise a shot that
      // succeeded on its second go would report failed for ever.
      expect(await reconcileShotStatus(shotId)).toBe('ready');
    });
  });
});

describe.skipIf(hasDatabase)('resume suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('Skipped: set DATABASE_URL and run `pnpm db:migrate` to execute these.');
    expect(hasDatabase).toBe(false);
  });
});
