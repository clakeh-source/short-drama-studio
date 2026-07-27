import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { assets, characters, episodes, scenes, series, shots, usageLog } from '@/lib/db/schema';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { loadEpisodeProgress, upsertAsset, updateAsset } from '@/lib/data/generation';
import { checkSpend, SpendCapError } from '@/lib/spend';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';

/**
 * Phase 3 criteria that need real rows: the spend cap (AC #6) and the
 * reconciliation between `usage_log` and `assets.cost_cents` (AC #5).
 *
 * Requires DATABASE_URL and a pushed schema. Skips rather than passing vacuously
 * without one. The criteria that additionally need a running Inngest dev server
 * and Storage credentials (AC #1-4) are listed in the README's verification
 * section — they cannot be asserted from a unit-test process.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

const userId = crypto.randomUUID();
let seriesId: string;
let episodeId: string;
let sceneId: string;
let shotIds: string[] = [];

const video = getVideoProvider('stub');
const tts = getTtsProvider('stub');

describe.skipIf(!hasDatabase).sequential('generation against a real database', () => {
  beforeAll(async () => {
    const handle = db();

    const [s] = await handle
      .insert(series)
      .values({
        userId,
        title: 'Phase 3 fixture',
        logline: 'A test series.',
        episodeTargetCount: 1,
        episodeTargetSeconds: 60,
      })
      .returning();
    seriesId = s!.id;

    const [character] = await handle
      .insert(characters)
      .values({
        seriesId,
        name: 'Mara',
        role: 'protagonist',
        appearancePrompt: 'a woman in her late twenties, dark hair, charcoal blazer',
        voiceId: 'stub-voice-lead-f',
      })
      .returning();

    const [e] = await handle
      .insert(episodes)
      .values({ seriesId, number: 1, title: 'Night 1', status: 'storyboarded' })
      .returning();
    episodeId = e!.id;

    const [sc] = await handle
      .insert(scenes)
      .values({ episodeId, orderIndex: 0, location: 'Lobby', timeOfDay: 'night' })
      .returning();
    sceneId = sc!.id;

    // Twelve shots, matching AC #1's episode size. Half carry a line.
    const rows = await handle
      .insert(shots)
      .values(
        Array.from({ length: 12 }, (_, i) => ({
          sceneId,
          orderIndex: i,
          durationSeconds: 5,
          camera: 'medium',
          action: `Beat ${i + 1}.`,
          dialogue: i % 2 === 0 ? 'You died in March.' : null,
          speakerCharacterId: i % 2 === 0 ? character!.id : null,
          characterIds: [character!.id],
          videoPrompt: `medium shot, a woman, beat ${i + 1}, Lobby, night, cinematic`,
          status: 'pending' as const,
        })),
      )
      .returning({ id: shots.id });

    shotIds = rows.map((r) => r.id);
  });

  afterAll(async () => {
    await db().delete(usageLog).where(eq(usageLog.userId, userId));
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('loads a 12-shot episode as pending', async () => {
    const progress = await loadEpisodeProgress(userId, episodeId);
    expect(progress.shots).toHaveLength(12);
    expect(progress.shots.every((s) => s.status === 'pending')).toBe(true);
  });

  it('AC #6 — a cap below the estimate refuses and reports the numbers', async () => {
    const shotRows = await db().select().from(shots).where(eq(shots.sceneId, sceneId));
    const estimate = estimateEpisodeCost(shotRows, video, tts);
    expect(estimate.totalCents).toBeGreaterThan(0);

    const original = process.env.MAX_MONTHLY_SPEND_CENTS;
    try {
      // A cap one cent under what the episode would cost.
      process.env.MAX_MONTHLY_SPEND_CENTS = String(estimate.totalCents - 1);
      const { resetEnvCache } = await import('@/lib/env');
      resetEnvCache();

      const check = await checkSpend(userId, estimate.totalCents);
      expect(check.allowed).toBe(false);
      expect(check.message).toMatch(/Nothing was queued/);
      expect(check.message).toMatch(/MAX_MONTHLY_SPEND_CENTS/);
    } finally {
      if (original === undefined) delete process.env.MAX_MONTHLY_SPEND_CENTS;
      else process.env.MAX_MONTHLY_SPEND_CENTS = original;
      const { resetEnvCache } = await import('@/lib/env');
      resetEnvCache();
    }
  });

  it('allows generation when the cap has room', async () => {
    const original = process.env.MAX_MONTHLY_SPEND_CENTS;
    try {
      process.env.MAX_MONTHLY_SPEND_CENTS = '100000';
      const { resetEnvCache } = await import('@/lib/env');
      resetEnvCache();

      const check = await checkSpend(userId, 100);
      expect(check.allowed).toBe(true);
      expect(check.message).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.MAX_MONTHLY_SPEND_CENTS;
      else process.env.MAX_MONTHLY_SPEND_CENTS = original;
      const { resetEnvCache } = await import('@/lib/env');
      resetEnvCache();
    }
  });

  it('creates one asset row per shot/kind/attempt, idempotently', async () => {
    const shotId = shotIds[0]!;

    const first = await upsertAsset({
      shotId,
      episodeId,
      kind: 'video',
      provider: 'stub',
      attempt: 0,
    });
    const again = await upsertAsset({
      shotId,
      episodeId,
      kind: 'video',
      provider: 'stub',
      attempt: 0,
    });

    // A re-executed step must not create a second row — that would double-count
    // the cost of the episode.
    expect(again.id).toBe(first.id);

    const retry = await upsertAsset({
      shotId,
      episodeId,
      kind: 'video',
      provider: 'stub',
      attempt: 1,
    });
    expect(retry.id).not.toBe(first.id);
  });

  it('AC #5 — usage_log for generation matches the sum of assets.cost_cents exactly', async () => {
    // Simulate a completed episode: every shot gets a video asset, and the ones
    // with a line get a voice asset, each writing a usage row with its real cost.
    const shotRows = await db().select().from(shots).where(eq(shots.sceneId, sceneId));

    for (const shot of shotRows) {
      const videoAsset = await upsertAsset({
        shotId: shot.id,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 5,
      });
      const videoCents = video.estimateCostCents({
        prompt: shot.videoPrompt ?? '',
        durationSeconds: shot.durationSeconds,
        aspectRatio: '9:16',
      });
      await updateAsset(videoAsset.id, { status: 'ready', costCents: videoCents });
      await recordUsage({
        userId,
        seriesId,
        episodeId,
        provider: 'stub',
        operation: 'video.generate',
        costCents: videoCents,
      });

      const dialogue = shot.dialogue?.trim();
      if (!dialogue) continue;

      const voiceAsset = await upsertAsset({
        shotId: shot.id,
        episodeId,
        kind: 'voice',
        provider: 'stub',
        attempt: 5,
      });
      const voiceCents = tts.estimateCostCents(dialogue);
      await updateAsset(voiceAsset.id, { status: 'ready', costCents: voiceCents });
      await recordUsage({
        userId,
        seriesId,
        episodeId,
        provider: 'stub',
        operation: 'voice.synthesize',
        costCents: voiceCents,
      });
    }

    const [assetTotal] = await db()
      .select({ total: sql<number>`coalesce(sum(${assets.costCents}), 0)::int` })
      .from(assets)
      .where(and(eq(assets.episodeId, episodeId), eq(assets.status, 'ready')));

    const [usageTotal] = await db()
      .select({ total: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int` })
      .from(usageLog)
      .where(
        and(
          eq(usageLog.episodeId, episodeId),
          inArray(usageLog.operation, ['video.generate', 'voice.synthesize']),
        ),
      );

    expect(usageTotal?.total).toBe(assetTotal?.total);
    expect(assetTotal?.total).toBeGreaterThan(0);
  });

  it('the status read surfaces costs and asset state per shot', async () => {
    const progress = await loadEpisodeProgress(userId, episodeId);
    const withVideo = progress.shots.filter((s) => s.video !== null);

    expect(withVideo.length).toBe(12);
    for (const shot of withVideo) {
      expect(shot.video!.costCents).toBeGreaterThan(0);
    }

    // Only the shots with a line have a voice asset.
    expect(progress.shots.filter((s) => s.voice !== null)).toHaveLength(6);
  });
});

describe('spend cap message', () => {
  it('states the numbers and how to change them', () => {
    const error = new SpendCapError(1800, 2000, 500);
    expect(error.message).toContain('$5.00');
    expect(error.message).toContain('$18.00');
    expect(error.message).toContain('$20.00');
    expect(error.message).toContain('Nothing was queued');
    expect(error.message).toContain('MAX_MONTHLY_SPEND_CENTS');
  });
});

describe.skipIf(hasDatabase)('generation DB suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn(
      'Generation DB tests skipped: set DATABASE_URL and run `pnpm db:push` to execute them.',
    );
    expect(hasDatabase).toBe(false);
  });
});
