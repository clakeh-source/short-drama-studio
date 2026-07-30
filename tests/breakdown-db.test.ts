import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import type { Shot } from '@/lib/db/schema';
import {
  PROTECTED_SHOT_STATUSES,
  protectedShotsFor,
  runBreakdown,
} from '@/lib/data/breakdown';
import { FAIL_MARKER, MALFORMED_MARKER } from '@/lib/providers/stub/support';
import { MAX_CLIP_SECONDS } from '@/lib/shots';

/**
 * Phase 3 acceptance, against a real database.
 *
 * The three criteria this covers are the ones that are only true end to end: a
 * script becoming rows, a bad model response leaving *nothing* behind, and a
 * regeneration that has to reason about work already in flight. None of them can
 * be demonstrated on the pure functions alone.
 *
 * Requires DATABASE_URL and `pnpm db:migrate`. Skips rather than passing
 * vacuously without them.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Force the stub language model.
 *
 * `runBreakdown` resolves its own provider — that is the point of it, and it is
 * why these tests can exercise the real route path. But `getLlmProvider()`
 * defaults to `anthropic` whenever `ANTHROPIC_API_KEY` is set, which it is in
 * any working `.env.local`. Without this line the suite quietly calls the real
 * API on every run: slow, non-deterministic, and billed. It also makes the
 * malformed-output test meaningless, since `[[stub:malformed]]` means nothing to
 * a real model.
 *
 * Set before any import that might read it, and restored by nothing — the value
 * is process-wide for this worker only.
 */
process.env.LLM_PROVIDER = 'stub';

const seedScript = await readFile('scripts/seed/episode-1.txt', 'utf8');

const userId = crypto.randomUUID();
let episodeId: string;
let meiId: string;

async function freshEpisode(scriptText: string): Promise<void> {
  await db().delete(series).where(eq(series.userId, userId));

  const [seriesRow] = await db()
    .insert(series)
    .values({ userId, title: 'Breakdown: The Last Ferry', logline: '', episodeTargetSeconds: 60 })
    .returning({ id: series.id });

  const [mei] = await db()
    .insert(characters)
    .values({ seriesId: seriesRow!.id, name: 'Mei Lin', appearancePrompt: 'a woman in her thirties' })
    .returning({ id: characters.id });

  await db()
    .insert(characters)
    .values({
      seriesId: seriesRow!.id,
      name: 'Daniel Voss',
      appearancePrompt: 'a man in his forties',
    });

  const [episode] = await db()
    .insert(episodes)
    .values({ seriesId: seriesRow!.id, number: 1, title: 'Manifest', scriptText })
    .returning({ id: episodes.id });

  meiId = mei!.id;
  episodeId = episode!.id;
}

/**
 * Captures a rejection as a plain object.
 *
 * `expect(...).rejects.toMatchObject` cannot be used on an `ApiError`: `message`
 * comes from `Error`'s constructor and is a non-enumerable own property, so the
 * matcher never sees it and the assertion fails for a reason that has nothing to
 * do with the error being right.
 */
async function rejection(
  promise: Promise<unknown>,
): Promise<{ status?: number; message: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; message?: string; details?: unknown };
    return { status: e.status, message: e.message ?? String(error), details: e.details };
  }
  throw new Error('Expected the call to be refused, but it resolved.');
}

/** Every shot on the episode, in scene then shot order. */
async function boardShots(): Promise<Shot[]> {
  const sceneRows = await db()
    .select()
    .from(scenes)
    .where(eq(scenes.episodeId, episodeId))
    .orderBy(asc(scenes.orderIndex));

  if (sceneRows.length === 0) return [];

  const rows = await db()
    .select()
    .from(shots)
    .where(
      inArray(
        shots.sceneId,
        sceneRows.map((s) => s.id),
      ),
    );

  return sceneRows.flatMap((scene) =>
    rows.filter((s) => s.sceneId === scene.id).sort((a, b) => a.orderIndex - b.orderIndex),
  );
}

describe.skipIf(!hasDatabase)('script breakdown, against the database', () => {
  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  describe('AC #1 — the seed script becomes a board', () => {
    beforeEach(async () => {
      await freshEpisode(seedScript);
    });

    it('persists scenes and shots', async () => {
      const diff = await runBreakdown({ userId, episodeId, mode: 'replace' });

      expect(diff.scenesAdded).toBeGreaterThanOrEqual(2);
      expect(diff.shotsAdded).toBeGreaterThan(diff.scenesAdded);

      const sceneRows = await db().select().from(scenes).where(eq(scenes.episodeId, episodeId));
      expect(sceneRows).toHaveLength(diff.scenesAdded);

      const board = await boardShots();
      expect(board).toHaveLength(diff.shotsAdded);
    });

    it('carries the script’s locations and times of day onto the scenes', async () => {
      await runBreakdown({ userId, episodeId, mode: 'replace' });

      const sceneRows = await db()
        .select()
        .from(scenes)
        .where(eq(scenes.episodeId, episodeId))
        .orderBy(asc(scenes.orderIndex));

      expect(sceneRows.map((s) => s.location.toLowerCase()).join(' | ')).toMatch(
        /harbour terminal/,
      );
      expect(sceneRows.every((s) => s.timeOfDay.length > 0)).toBe(true);
    });

    it('maps named characters onto Character rows', async () => {
      await runBreakdown({ userId, episodeId, mode: 'replace' });

      const board = await boardShots();
      const withMei = board.filter((s) => s.characterIds.includes(meiId));

      expect(withMei.length).toBeGreaterThan(0);
      // The speaker is on the shot, not merely mentioned in its prompt.
      expect(board.some((s) => s.speakerCharacterId === meiId)).toBe(true);
    });

    it('flags names the cast has no row for instead of dropping them', async () => {
      // "Harbour Guard" is in this script and in nobody's cast list.
      await freshEpisode(
        `${seedScript}\n\nINT. GANGWAY - NIGHT\n\nA HARBOUR GUARD steps out of the dark.\n\nHARBOUR GUARD\nTickets.\n`,
      );

      const diff = await runBreakdown({ userId, episodeId, mode: 'replace' });

      expect(diff.unmatchedCharacters).toContain('Harbour Guard');

      const board = await boardShots();
      const flagged = board.filter((s) => s.unmatchedCharacters.length > 0);
      expect(flagged.length).toBeGreaterThan(0);
    });

    it('never writes a shot longer than the provider will render', async () => {
      await runBreakdown({ userId, episodeId, mode: 'replace' });

      for (const shot of await boardShots()) {
        expect(shot.durationSeconds).toBeGreaterThan(0);
        expect(shot.durationSeconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
      }
    });

    it('composes a video prompt for every shot', async () => {
      await runBreakdown({ userId, episodeId, mode: 'replace' });

      for (const shot of await boardShots()) {
        expect(shot.videoPrompt?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });

  describe('AC #2 — malformed model output', () => {
    it('is rejected with the raw output, and persists nothing', async () => {
      // The marker makes the stub answer with prose. The call succeeds and is
      // billed; it just returns something no schema will ever accept.
      await freshEpisode(`${MALFORMED_MARKER}\n\n${seedScript}`);

      const refusal = await rejection(runBreakdown({ userId, episodeId, mode: 'replace' }));

      expect(refusal.status).toBe(400);
      expect(refusal.message).toMatch(/did not match the schema/);
      // Surfacing the raw output is the difference between "generation failed"
      // and being able to see that the model wrote prose.
      expect(refusal.details).toMatchObject({
        rawOutput: expect.stringMatching(/written out as prose/),
      });

      // Not "mostly nothing" — nothing. The failure happens before the
      // transaction opens, so there is no partial board to clean up.
      expect(await db().select().from(scenes).where(eq(scenes.episodeId, episodeId))).toHaveLength(
        0,
      );
      expect(await boardShots()).toHaveLength(0);
    });

    it('is told apart from the model being unreachable', async () => {
      // A provider outage and a bad answer both exhaust the retry budget and
      // both surface as JsonGenerationError. Reporting the first as "the output
      // did not match the schema" sends someone to stare at a prompt that was
      // never the problem — which is exactly what happened the first time this
      // ran against an Anthropic account with no credit on it.
      await freshEpisode(`${FAIL_MARKER}\n\n${seedScript}`);

      const refusal = await rejection(runBreakdown({ userId, episodeId, mode: 'replace' }));

      expect(refusal.status).toBe(502);
      expect(refusal.message).toMatch(/could not be reached/);
      expect(refusal.message).not.toMatch(/schema/);
      // There is no raw output to show, and claiming otherwise would be a lie.
      expect(refusal.details).not.toHaveProperty('rawOutput');

      expect(await boardShots()).toHaveLength(0);
    });

    it('leaves an existing board intact when a regeneration fails', async () => {
      await freshEpisode(seedScript);
      const good = await runBreakdown({ userId, episodeId, mode: 'replace' });

      const before = await boardShots();
      expect(before.length).toBe(good.shotsAdded);

      await db()
        .update(episodes)
        .set({ scriptText: `${MALFORMED_MARKER}\n\n${seedScript}` })
        .where(eq(episodes.id, episodeId));

      expect((await rejection(runBreakdown({ userId, episodeId, mode: 'merge' }))).status).toBe(
        400,
      );

      const after = await boardShots();
      expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    });
  });

  describe('AC #3 — regenerating around work in flight', () => {
    beforeEach(async () => {
      await freshEpisode(seedScript);
      await runBreakdown({ userId, episodeId, mode: 'replace' });
    });

    it.each(PROTECTED_SHOT_STATUSES)('does not touch a %s shot', async (status) => {
      const board = await boardShots();
      const target = board[0]!;

      await db()
        .update(shots)
        .set({ status, videoPrompt: 'do not touch me' })
        .where(eq(shots.id, target.id));

      const diff = await runBreakdown({ userId, episodeId, mode: 'merge' });

      const [after] = await db().select().from(shots).where(eq(shots.id, target.id));

      // Same row, same prompt, same duration. Not "recreated identically" —
      // untouched, which is what makes a generating clip survive.
      expect(after).toBeDefined();
      expect(after!.status).toBe(status);
      expect(after!.videoPrompt).toBe('do not touch me');
      expect(after!.durationSeconds).toBe(target.durationSeconds);
      expect(diff.preservedShotIds).toContain(target.id);
      expect(diff.shotsPreserved).toBeGreaterThan(0);
    });

    it('preserves every shot in the scene, not just the protected one', async () => {
      const board = await boardShots();
      const target = board[0]!;
      const siblings = board.filter((s) => s.sceneId === target.sceneId);
      expect(siblings.length).toBeGreaterThan(1);

      await db().update(shots).set({ status: 'ready' }).where(eq(shots.id, target.id));

      await runBreakdown({ userId, episodeId, mode: 'merge' });

      // Renumbering a scene around a shot that is mid-generation would leave the
      // finished clip sitting at the wrong point in the cut.
      const after = await boardShots();
      for (const sibling of siblings) {
        expect(after.some((s) => s.id === sibling.id)).toBe(true);
      }
    });

    it('rebuilds the scenes that have nothing in flight', async () => {
      const board = await boardShots();
      const protectedSceneId = board[0]!.sceneId;
      await db().update(shots).set({ status: 'ready' }).where(eq(shots.id, board[0]!.id));

      const untouchedBefore = board.filter((s) => s.sceneId !== protectedSceneId);
      expect(untouchedBefore.length).toBeGreaterThan(0);

      const diff = await runBreakdown({ userId, episodeId, mode: 'merge' });

      expect(diff.scenesPreserved).toBe(1);
      expect(diff.scenesReplaced).toBeGreaterThan(0);

      // Those shots are genuinely new rows — the scene was rebuilt.
      const after = await boardShots();
      for (const old of untouchedBefore) {
        expect(after.some((s) => s.id === old.id)).toBe(false);
      }
    });

    it('reports what it did, so the caller need not diff the board themselves', async () => {
      const board = await boardShots();
      await db().update(shots).set({ status: 'generating' }).where(eq(shots.id, board[0]!.id));

      const diff = await runBreakdown({ userId, episodeId, mode: 'merge' });

      expect(diff.mode).toBe('merge');
      expect(diff.scenesPreserved + diff.scenesReplaced + diff.scenesAdded).toBeGreaterThan(0);
      expect(diff.totalSeconds).toBeGreaterThan(0);
      expect(diff.attempts).toBeGreaterThanOrEqual(1);
    });

    it('refuses a destructive rebuild while shots are in flight', async () => {
      const board = await boardShots();
      await db().update(shots).set({ status: 'generating' }).where(eq(shots.id, board[0]!.id));

      // What the /breakdown route checks before it does anything at all.
      const inFlight = await protectedShotsFor(userId, episodeId);
      expect(inFlight.map((s) => s.id)).toContain(board[0]!.id);
    });

    it('leaves a board with nothing in flight fully rebuildable', async () => {
      const before = await boardShots();

      const diff = await runBreakdown({ userId, episodeId, mode: 'merge' });

      expect(diff.shotsPreserved).toBe(0);
      expect(diff.scenesPreserved).toBe(0);

      const after = await boardShots();
      expect(after.some((s) => before.some((b) => b.id === s.id))).toBe(false);
    });
  });
});

describe.skipIf(hasDatabase)('breakdown database suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('Skipped: set DATABASE_URL and run `pnpm db:migrate` to execute these.');
    expect(hasDatabase).toBe(false);
  });
});
