import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { assets, characters, episodes, scenes, series, shots, usageLog } from '@/lib/db/schema';
import {
  claimVideoSlot,
  MAX_INFLIGHT_VIDEO_JOBS,
  reconcileShotStatus,
  updateAsset,
  upsertAsset,
} from '@/lib/data/generation';
import { recordUsage } from '@/lib/usage';

/**
 * The two defects the first full walkthrough exposed, both of which needed real
 * rows to see:
 *
 * 1. The video job set the shot to `ready` on its own, so an episode whose every
 *    voice job had failed still showed a green board and an enabled Render
 *    button — a silent film, one click from export.
 * 2. Inngest's `concurrency` bounds step execution, not provider work, and the
 *    poll loop hands its slot back on every `step.sleep`. A 20-shot episode
 *    submitted all 20 clips before the first finished: a measured peak of 20 live
 *    provider jobs against a stated limit of 3.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

const userId = crypto.randomUUID();
let episodeId: string;
let sceneId: string;
/** With a line, so it needs both a clip and a voice. */
let dialogueShotId: string;
/** Silent, so a clip alone is enough. */
let silentShotId: string;

describe.skipIf(!hasDatabase).sequential('shot readiness and admission control', () => {
  beforeAll(async () => {
    const handle = db();

    const [s] = await handle
      .insert(series)
      .values({
        userId,
        title: 'Readiness fixture',
        logline: 'A test series.',
        episodeTargetCount: 1,
        episodeTargetSeconds: 60,
      })
      .returning();

    const [character] = await handle
      .insert(characters)
      .values({
        seriesId: s!.id,
        name: 'Mara',
        role: 'protagonist',
        appearancePrompt: 'a woman in her late twenties, dark hair, charcoal blazer',
        voiceId: 'stub-voice-lead-f',
      })
      .returning();

    const [e] = await handle
      .insert(episodes)
      .values({ seriesId: s!.id, number: 1, title: 'Night 1', status: 'generating' })
      .returning();
    episodeId = e!.id;

    const [sc] = await handle
      .insert(scenes)
      .values({ episodeId, orderIndex: 0, location: 'Lobby', timeOfDay: 'night' })
      .returning();
    sceneId = sc!.id;

    const rows = await handle
      .insert(shots)
      .values([
        {
          sceneId,
          orderIndex: 0,
          durationSeconds: 5,
          camera: 'medium',
          action: 'She speaks.',
          dialogue: 'You died in March.',
          speakerCharacterId: character!.id,
          characterIds: [character!.id],
          videoPrompt: 'medium shot, a woman, Lobby, night, cinematic',
          status: 'pending' as const,
        },
        {
          sceneId,
          orderIndex: 1,
          durationSeconds: 5,
          camera: 'wide',
          action: 'An empty lobby.',
          dialogue: null,
          characterIds: [],
          videoPrompt: 'wide shot, an empty lobby, night, cinematic',
          status: 'pending' as const,
        },
      ])
      .returning({ id: shots.id });

    dialogueShotId = rows[0]!.id;
    silentShotId = rows[1]!.id;
  });

  afterAll(async () => {
    await db().delete(usageLog).where(eq(usageLog.userId, userId));
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  async function readyAsset(shotId: string, kind: 'video' | 'voice'): Promise<string> {
    const row = await upsertAsset({ shotId, episodeId, kind, provider: 'stub', attempt: 0 });
    await updateAsset(row.id, { status: 'ready', storagePath: `x/${row.id}`, costCents: 1 });
    return row.id;
  }

  it('a spoken shot with only a clip is NOT ready', async () => {
    await readyAsset(dialogueShotId, 'video');
    expect(await reconcileShotStatus(dialogueShotId)).toBe('generating');
  });

  it('a silent shot needs only its clip', async () => {
    await readyAsset(silentShotId, 'video');
    expect(await reconcileShotStatus(silentShotId)).toBe('ready');
  });

  it('the spoken shot becomes ready once its voice lands too', async () => {
    await readyAsset(dialogueShotId, 'voice');
    expect(await reconcileShotStatus(dialogueShotId)).toBe('ready');
  });

  it('settles the episode off `generating` once every shot has finished', async () => {
    const [row] = await db().select().from(episodes).where(eq(episodes.id, episodeId));
    expect(row!.status).toBe('storyboarded');
  });

  it('a failed voice fails the shot rather than leaving it green', async () => {
    const voice = await upsertAsset({
      shotId: dialogueShotId,
      episodeId,
      kind: 'voice',
      provider: 'stub',
      attempt: 1,
    });
    await updateAsset(voice.id, { status: 'failed', error: 'stub: no voice' });

    // Attempt 0 succeeded, so the kind still counts as ready: a later retry
    // failing must not undo a clip that is genuinely present.
    expect(await reconcileShotStatus(dialogueShotId)).toBe('ready');

    // With *every* voice attempt failed, the shot is failed.
    await db()
      .update(assets)
      .set({ status: 'failed' })
      .where(eq(assets.shotId, dialogueShotId));
    expect(await reconcileShotStatus(dialogueShotId)).toBe('failed');
  });

  /**
   * A restart mid-generation produced 21 ledger rows for 20 clips — 315c
   * recorded against 300c of assets — because `recordUsage` was an
   * unconditional insert inside a step Inngest may re-run. The assets were
   * correct; only the ledger was wrong, which is the AC #5 invariant.
   *
   * The kill/restart run that verified AC #2 happened not to land in that
   * window, so the guard is asserted directly here rather than left to chance.
   */
  describe('usage is charged at most once', () => {
    const key = `video.generate:${crypto.randomUUID()}:0`;

    const charge = () =>
      recordUsage({
        userId,
        episodeId,
        provider: 'stub',
        operation: 'video.generate',
        costCents: 25,
        idempotencyKey: key,
      });

    it('records the first charge and suppresses a replay', async () => {
      expect(await charge(), 'first call should insert').toBe(true);
      expect(await charge(), 'replay must not insert').toBe(false);

      const rows = await db()
        .select()
        .from(usageLog)
        .where(eq(usageLog.idempotencyKey, key));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.costCents).toBe(25);
    });

    it('suppresses concurrent replays too, not just sequential ones', async () => {
      const concurrentKey = `voice.synthesize:${crypto.randomUUID()}:0`;
      const once = () =>
        recordUsage({
          userId,
          episodeId,
          provider: 'stub',
          operation: 'voice.synthesize',
          costCents: 3,
          idempotencyKey: concurrentKey,
        });

      const results = await Promise.all([once(), once(), once(), once()]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const rows = await db()
        .select()
        .from(usageLog)
        .where(eq(usageLog.idempotencyKey, concurrentKey));
      expect(rows).toHaveLength(1);
    });

    it('leaves unkeyed callers unconstrained, so one-off calls still record', async () => {
      const operation = `test.unkeyed.${crypto.randomUUID()}`;
      expect(await recordUsage({ userId, provider: 'stub', operation, costCents: 1 })).toBe(true);
      expect(await recordUsage({ userId, provider: 'stub', operation, costCents: 1 })).toBe(true);

      const rows = await db().select().from(usageLog).where(eq(usageLog.operation, operation));
      expect(rows).toHaveLength(2);
    });
  });

  describe('admission control', () => {
    it(`admits exactly ${MAX_INFLIGHT_VIDEO_JOBS} and refuses the next`, async () => {
      // Clear the slate: nothing of this user's in flight.
      await db().delete(assets).where(eq(assets.episodeId, episodeId));

      const candidates = await Promise.all(
        Array.from({ length: MAX_INFLIGHT_VIDEO_JOBS + 2 }, (_, i) =>
          upsertAsset({
            shotId: dialogueShotId,
            episodeId,
            kind: 'video',
            provider: 'stub',
            attempt: 100 + i,
          }),
        ),
      );

      const admitted: boolean[] = [];
      for (const asset of candidates) {
        admitted.push(await claimVideoSlot(userId, asset.id));
      }

      expect(admitted.filter(Boolean)).toHaveLength(MAX_INFLIGHT_VIDEO_JOBS);
      // The refusals are the ones at the end, not a random subset.
      expect(admitted.slice(0, MAX_INFLIGHT_VIDEO_JOBS).every(Boolean)).toBe(true);
      expect(admitted.slice(MAX_INFLIGHT_VIDEO_JOBS).some(Boolean)).toBe(false);
    });

    it('frees a slot when a job reaches a terminal status', async () => {
      const inflight = await db()
        .select()
        .from(assets)
        .where(eq(assets.status, 'generating'));
      expect(inflight.length).toBe(MAX_INFLIGHT_VIDEO_JOBS);

      await updateAsset(inflight[0]!.id, { status: 'ready', costCents: 1 });

      const next = await upsertAsset({
        shotId: dialogueShotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 200,
      });
      expect(await claimVideoSlot(userId, next.id)).toBe(true);
    });

    it('does not let concurrent claims exceed the limit', async () => {
      await db().delete(assets).where(eq(assets.episodeId, episodeId));

      const candidates = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          upsertAsset({
            shotId: dialogueShotId,
            episodeId,
            kind: 'video',
            provider: 'stub',
            attempt: 300 + i,
          }),
        ),
      );

      // All at once — the advisory lock is what stops two claims both seeing
      // two in flight and both proceeding to a third.
      const results = await Promise.all(candidates.map((a) => claimVideoSlot(userId, a.id)));
      expect(results.filter(Boolean)).toHaveLength(MAX_INFLIGHT_VIDEO_JOBS);
    });
  });
});
