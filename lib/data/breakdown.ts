import 'server-only';

import { asc, eq, inArray } from 'drizzle-orm';
import { withUserDb, type Transaction } from '@/lib/db';
import { characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import type { Character, Scene as SceneRow, Shot } from '@/lib/db/schema';
import type { Breakdown, BreakdownScene } from '@/lib/ai/schemas';
import { generateBreakdown } from '@/lib/ai/breakdown';
import { JsonGenerationError } from '@/lib/ai/json';
import { normaliseCamera } from '@/lib/ai/prompts';
import { composePromptsForShot } from '@/lib/data/storyboard';
import { loadEpisode } from '@/lib/data/series';
import { ApiError, badRequest, notFound } from '@/lib/api/handler';
import { getLlmProvider, getVideoProvider, type LlmStreamChunk } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { log } from '@/lib/log';

/**
 * Turning a model breakdown into `scenes` and `shots` rows.
 *
 * Two modes, and the difference between them is the whole point of this module.
 * `replace` throws the board away and rebuilds it, which is right the first
 * time. `merge` is for re-running a breakdown on an episode that is already in
 * flight, and it must not destroy work that has been paid for — a shot that is
 * generating, or has a finished clip, represents real money and real waiting.
 */

/**
 * Shot states a regeneration will not touch.
 *
 * `ready` and `generating` are the spec's, and obvious: one has a clip, the
 * other is producing one. `queued` is here too because deleting a queued shot
 * does not cancel the job that is about to run — the worker would wake up, find
 * its shot gone, and either crash or write an orphaned asset. Cheaper to keep
 * the row than to invent job cancellation for a case nobody wants.
 */
export const PROTECTED_SHOT_STATUSES = ['queued', 'generating', 'ready'] as const;

type ProtectedStatus = (typeof PROTECTED_SHOT_STATUSES)[number];

function isProtected(shot: Shot): boolean {
  return (PROTECTED_SHOT_STATUSES as readonly string[]).includes(shot.status);
}

/* -------------------------------------------------------------------------- */
/* Character name mapping                                                     */
/* -------------------------------------------------------------------------- */

export interface NameMapping {
  ids: string[];
  /** Names with no Character in this series. Recorded, never discarded. */
  unmatched: string[];
}

/**
 * Maps script names onto Character rows.
 *
 * Exact match first, then a unique first-name match — screenplays cue people by
 * first name ("MEI") far more often than by the full name the cast list holds
 * ("Mei Lin"), and refusing that would report half a real cast as unmatched.
 * The first-name pass is skipped when it is ambiguous: two characters called
 * Mei means the script has to say which.
 *
 * Anything left over comes back in `unmatched` rather than being dropped. A shot
 * that quietly claims nobody is in it is a defect the user cannot see.
 */
export function mapCharacterNames(
  names: readonly string[],
  cast: readonly Pick<Character, 'id' | 'name'>[],
): NameMapping {
  const byFullName = new Map<string, string>();
  const byFirstName = new Map<string, string | null>();

  for (const member of cast) {
    byFullName.set(member.name.trim().toLowerCase(), member.id);

    const first = member.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first) continue;
    // null marks "more than one character answers to this", which disqualifies it.
    byFirstName.set(first, byFirstName.has(first) ? null : member.id);
  }

  const ids: string[] = [];
  const unmatched: string[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    const id = byFullName.get(key) ?? byFirstName.get(key) ?? null;

    if (id) {
      if (!ids.includes(id)) ids.push(id);
    } else if (!unmatched.includes(name)) {
      unmatched.push(name);
    }
  }

  return { ids, unmatched };
}

/* -------------------------------------------------------------------------- */
/* Persisting                                                                 */
/* -------------------------------------------------------------------------- */

export interface PersistBreakdownInput {
  userId: string;
  episodeId: string;
  breakdown: Breakdown;
  /** `replace` rebuilds the board; `merge` preserves in-flight scenes. */
  mode: 'replace' | 'merge';
  /** Provider duration grid, injected so this stays provider-agnostic. */
  clampDuration: (seconds: number) => number;
}

export interface BreakdownDiff {
  mode: 'replace' | 'merge';
  scenesAdded: number;
  /** Matched an existing scene with no protected shots, and was rebuilt. */
  scenesReplaced: number;
  /** Left exactly as it was because something in it is in flight. */
  scenesPreserved: number;
  scenesRemoved: number;
  shotsAdded: number;
  shotsRemoved: number;
  shotsPreserved: number;
  /** Ids of every shot this run deliberately did not touch. */
  preservedShotIds: string[];
  /** Distinct script names with no Character row, for manual linking. */
  unmatchedCharacters: string[];
  totalSeconds: number;
}

/** Location plus time of day, which is how a screenplay identifies a scene. */
function sceneKey(scene: { location: string; timeOfDay: string }): string {
  return `${scene.location.trim().toLowerCase()}|${scene.timeOfDay.trim().toLowerCase()}`;
}

function breakdownSceneKey(scene: BreakdownScene): string {
  return sceneKey({ location: scene.location, timeOfDay: scene.time_of_day });
}

export async function persistBreakdown(
  input: PersistBreakdownInput,
): Promise<BreakdownDiff> {
  return withUserDb(input.userId, async (tx) => {
    const [episode] = await tx
      .select()
      .from(episodes)
      .where(eq(episodes.id, input.episodeId));
    if (!episode) throw notFound('Episode not found');

    const [seriesRow] = await tx.select().from(series).where(eq(series.id, episode.seriesId));
    const styleSuffix =
      (seriesRow?.bible as { visual_style?: string } | null)?.visual_style ?? null;

    const cast = await tx
      .select()
      .from(characters)
      .where(eq(characters.seriesId, episode.seriesId))
      .orderBy(asc(characters.createdAt));

    const existing = await loadExistingScenes(tx, input.episodeId);

    const diff: BreakdownDiff = {
      mode: input.mode,
      scenesAdded: 0,
      scenesReplaced: 0,
      scenesPreserved: 0,
      scenesRemoved: 0,
      shotsAdded: 0,
      shotsRemoved: 0,
      shotsPreserved: 0,
      preservedShotIds: [],
      unmatchedCharacters: [],
      totalSeconds: 0,
    };

    /* -- decide what survives ------------------------------------------- */

    const preserved = new Map<string, ExistingScene>();
    if (input.mode === 'merge') {
      for (const scene of existing) {
        if (scene.shots.some(isProtected)) preserved.set(sceneKey(scene.scene), scene);
      }
    }

    const doomed = existing.filter((scene) => !preserved.has(sceneKey(scene.scene)));

    if (doomed.length > 0) {
      diff.scenesRemoved = doomed.length;
      diff.shotsRemoved = doomed.reduce((n, s) => n + s.shots.length, 0);
      // Cascades to shots and their assets.
      await tx.delete(scenes).where(
        inArray(
          scenes.id,
          doomed.map((s) => s.scene.id),
        ),
      );
    }

    /* -- lay the new board out ------------------------------------------ */

    const seenKeys = new Set<string>();
    let orderIndex = 0;

    for (const scene of input.breakdown.scenes) {
      const key = breakdownSceneKey(scene);
      seenKeys.add(key);

      const survivor = preserved.get(key);

      if (survivor) {
        // Untouched, down to the shot rows. Only its position moves, so the new
        // breakdown's scene order still reads correctly.
        if (survivor.scene.orderIndex !== orderIndex) {
          await tx
            .update(scenes)
            .set({ orderIndex })
            .where(eq(scenes.id, survivor.scene.id));
        }

        diff.scenesPreserved += 1;
        diff.shotsPreserved += survivor.shots.length;
        diff.preservedShotIds.push(...survivor.shots.map((s) => s.id));
        diff.totalSeconds += survivor.shots.reduce((n, s) => n + s.durationSeconds, 0);
        orderIndex += 1;
        continue;
      }

      const wasThereBefore = doomed.some((s) => sceneKey(s.scene) === key);
      if (wasThereBefore) diff.scenesReplaced += 1;
      else diff.scenesAdded += 1;

      const written = await insertScene({
        tx,
        episodeId: input.episodeId,
        orderIndex,
        scene,
        cast,
        styleSuffix,
        clampDuration: input.clampDuration,
      });

      diff.shotsAdded += written.shotCount;
      diff.totalSeconds += written.seconds;
      for (const name of written.unmatched) {
        if (!diff.unmatchedCharacters.includes(name)) diff.unmatchedCharacters.push(name);
      }

      orderIndex += 1;
    }

    /* -- in-flight scenes the new breakdown does not mention ------------- */

    for (const [key, survivor] of preserved) {
      if (seenKeys.has(key)) continue;

      // The breakdown no longer has this scene, but something in it is
      // generating or already generated. Deleting it would throw away a paid-for
      // clip on the strength of a model re-read, so it moves to the end instead
      // and the diff says so.
      await tx.update(scenes).set({ orderIndex }).where(eq(scenes.id, survivor.scene.id));

      diff.scenesPreserved += 1;
      diff.shotsPreserved += survivor.shots.length;
      diff.preservedShotIds.push(...survivor.shots.map((s) => s.id));
      diff.totalSeconds += survivor.shots.reduce((n, s) => n + s.durationSeconds, 0);
      orderIndex += 1;
    }

    await tx
      .update(episodes)
      .set({ status: 'storyboarded' })
      .where(eq(episodes.id, input.episodeId));

    log.info('breakdown persisted', {
      userId: input.userId,
      episodeId: input.episodeId,
      operation: 'breakdown.persist',
      ...diff,
      preservedShotIds: diff.preservedShotIds.length,
    });

    return diff;
  });
}

/* -------------------------------------------------------------------------- */

interface ExistingScene {
  scene: SceneRow;
  shots: Shot[];
}

async function loadExistingScenes(
  tx: Transaction,
  episodeId: string,
): Promise<ExistingScene[]> {
  const sceneRows = await tx
    .select()
    .from(scenes)
    .where(eq(scenes.episodeId, episodeId))
    .orderBy(asc(scenes.orderIndex));

  if (sceneRows.length === 0) return [];

  const shotRows = await tx
    .select()
    .from(shots)
    .where(
      inArray(
        shots.sceneId,
        sceneRows.map((s) => s.id),
      ),
    )
    .orderBy(asc(shots.orderIndex));

  return sceneRows.map((scene) => ({
    scene,
    shots: shotRows.filter((shot) => shot.sceneId === scene.id),
  }));
}

async function insertScene(input: {
  tx: Transaction;
  episodeId: string;
  orderIndex: number;
  scene: BreakdownScene;
  cast: Character[];
  styleSuffix: string | null;
  clampDuration: (seconds: number) => number;
}): Promise<{ shotCount: number; seconds: number; unmatched: string[] }> {
  const [sceneRow] = await input.tx
    .insert(scenes)
    .values({
      episodeId: input.episodeId,
      orderIndex: input.orderIndex,
      location: input.scene.location,
      timeOfDay: input.scene.time_of_day,
      summary: input.scene.summary,
    })
    .returning();

  const unmatched: string[] = [];
  let seconds = 0;

  const values = input.scene.shots.map((shot, shotIndex) => {
    // The speaker is in frame whether or not the model listed them — a line
    // comes from someone, and a shot that plays their audio with their face
    // absent from the prompt is how a character changes appearance mid-scene.
    const named = shot.speaker ? [shot.speaker, ...shot.characters] : shot.characters;
    const mapping = mapCharacterNames(named, input.cast);

    for (const name of mapping.unmatched) {
      if (!unmatched.includes(name)) unmatched.push(name);
    }

    const speaker = shot.speaker
      ? mapCharacterNames([shot.speaker], input.cast).ids[0] ?? null
      : null;

    // The script's implied length, snapped to what the provider will render.
    // Not refitted toward an episode budget the way a generated storyboard is:
    // a script the user brought is however long it is.
    const durationSeconds = input.clampDuration(shot.duration_seconds);
    seconds += durationSeconds;

    const camera = normaliseCamera(shot.camera);

    const prompts = composePromptsForShot(
      { camera, action: shot.action, characterIds: mapping.ids, promptOverride: null },
      { location: input.scene.location, timeOfDay: input.scene.time_of_day },
      input.cast,
      input.styleSuffix,
    );

    return {
      sceneId: sceneRow!.id,
      orderIndex: shotIndex,
      durationSeconds,
      camera,
      action: shot.action,
      dialogue: shot.dialogue ?? null,
      speakerCharacterId: speaker,
      characterIds: mapping.ids,
      unmatchedCharacters: mapping.unmatched,
      imagePrompt: prompts.imagePrompt,
      videoPrompt: prompts.videoPrompt,
      negativePrompt: prompts.negativePrompt,
      status: 'pending' as const,
    };
  });

  await input.tx.insert(shots).values(values);

  return { shotCount: values.length, seconds, unmatched };
}

/* -------------------------------------------------------------------------- */
/* Running one                                                                */
/* -------------------------------------------------------------------------- */

export interface RunBreakdownInput {
  userId: string;
  episodeId: string;
  mode: 'replace' | 'merge';
  onDelta?: (chunk: LlmStreamChunk) => void;
  onStatus?: (message: string) => void;
}

export interface RunBreakdownResult extends BreakdownDiff {
  attempts: number;
  costCents: number;
}

/**
 * Read the stored script, ask the model to break it down, persist the result.
 *
 * Shared by both entry points because the only thing that differs between a
 * first breakdown and a regeneration is `mode` — and letting that difference
 * live in two copies of the same forty lines is how the two drift apart.
 *
 * Nothing is written until the model output has parsed and validated. That is
 * what makes "malformed output is rejected, not partially persisted" true by
 * construction rather than by careful cleanup: the failure happens before the
 * transaction opens.
 */
export async function runBreakdown(input: RunBreakdownInput): Promise<RunBreakdownResult> {
  const { episode, series: seriesRow, characters: cast } = await loadEpisode(
    input.userId,
    input.episodeId,
  );

  const scriptText = episode.scriptText?.trim();
  if (!scriptText) {
    throw badRequest(
      'This episode has no script text yet. POST the script to /api/episodes/' +
        `${input.episodeId}/script first.`,
    );
  }

  const llm = getLlmProvider();
  const video = getVideoProvider();

  input.onStatus?.('Reading the script…');

  let result;
  try {
    result = await generateBreakdown({
      provider: llm,
      scriptText,
      castNames: cast.map((c) => c.name),
      seriesTitle: seriesRow.title,
      ...(input.onDelta ? { onDelta: input.onDelta } : {}),
    });
  } catch (error) {
    if (error instanceof JsonGenerationError) {
      // The model never answered — an outage, a rate limit, an empty account.
      // Saying "the output did not match the schema" here would send someone to
      // stare at a prompt that was never the problem, so this reports what
      // actually happened and does not pretend there is raw output to inspect.
      if (error.kind === 'provider') {
        throw new ApiError(
          502,
          'provider_error',
          'The model could not be reached, so nothing was saved. ' +
            (error.providerError ?? 'The provider gave no reason.'),
          { attempts: error.attempts },
        );
      }

      // The model did answer, and the answer was unusable. Surfacing the raw
      // output is the difference between "generation failed" and being able to
      // see that it wrote prose, or truncated, or invented a camera angle.
      throw badRequest(
        'The model returned a breakdown that did not match the schema, so nothing was ' +
          `saved. It tried ${error.attempts} times.`,
        { attempts: error.attempts, rawOutput: error.lastRaw.slice(0, 8000) },
      );
    }
    throw error;
  }

  input.onStatus?.('Laying out the board…');

  const diff = await persistBreakdown({
    userId: input.userId,
    episodeId: input.episodeId,
    breakdown: result.data,
    mode: input.mode,
    clampDuration: (seconds) => video.clampDuration(seconds),
  });

  await recordUsage({
    userId: input.userId,
    seriesId: seriesRow.id,
    episodeId: episode.id,
    provider: llm.id,
    operation: 'breakdown.generate',
    costCents: result.usage.costCents,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
  });

  return { ...diff, attempts: result.attempts, costCents: result.usage.costCents };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/** Shots a destructive rebuild would throw away. Empty means `replace` is safe. */
export async function protectedShotsFor(
  userId: string,
  episodeId: string,
): Promise<Array<{ id: string; status: ProtectedStatus }>> {
  return withUserDb(userId, async (tx) => {
    const rows = await tx
      .select({ id: shots.id, status: shots.status })
      .from(shots)
      .innerJoin(scenes, eq(scenes.id, shots.sceneId))
      .where(eq(scenes.episodeId, episodeId));

    return rows.filter((row): row is { id: string; status: ProtectedStatus } =>
      (PROTECTED_SHOT_STATUSES as readonly string[]).includes(row.status),
    );
  });
}
