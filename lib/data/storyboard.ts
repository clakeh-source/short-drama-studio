import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';
import { withUserDb, type Transaction } from '@/lib/db';
import { characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import type { Character, Scene as SceneRow, Shot } from '@/lib/db/schema';
import {
  composeImagePrompt,
  composeNegativePrompt,
  composeVideoPrompt,
  normaliseCamera,
  type PromptCharacter,
} from '@/lib/ai/prompts';
import type { Bible, Script, Storyboard } from '@/lib/ai/schemas';
import { fitShotDurations } from '@/lib/shots';
import { notFound } from '@/lib/api/handler';

/**
 * Turning a generated storyboard into `scenes` and `shots` rows, and keeping
 * the composed prompts in step with every later edit.
 *
 * Prompts are never stored as the model wrote them — they are always recomposed
 * from the current camera, cast, action, location and series style, so editing
 * a character's appearance updates every shot they are in. The one exception is
 * `prompt_override`, which is the human's word and is left alone.
 */

export interface StoryboardScene {
  scene: SceneRow;
  shots: Shot[];
}

export interface StoryboardDetail {
  scenes: StoryboardScene[];
  characters: Character[];
}

/** Everything the storyboard page renders, from one round of queries. */
export interface StoryboardPage extends StoryboardDetail {
  series: typeof series.$inferSelect;
  episode: typeof episodes.$inferSelect;
}

/**
 * Loads the whole storyboard page in a single transaction.
 *
 * The page used to call `loadEpisodeByNumber` and then `loadStoryboard`, which
 * meant two `withUserDb` transactions — each paying a `BEGIN`, two `set_config`
 * round trips and a `COMMIT` — and loading the cast twice. Against a Supabase
 * instance in another region every one of those round trips is tens of
 * milliseconds, and they landed squarely in front of the first byte: Lighthouse
 * measured a 500ms server response and a 2.4s LCP on this route.
 *
 * Shots are fetched by joining through `scenes` rather than by collecting scene
 * ids first, so the query does not have to wait for the previous result.
 */
export async function loadStoryboardPage(
  userId: string,
  seriesId: string,
  episodeNumber: number,
): Promise<StoryboardPage> {
  return withUserDb(userId, async (tx) => {
    const [seriesRow] = await tx.select().from(series).where(eq(series.id, seriesId));
    if (!seriesRow) throw notFound('Series not found');

    const [episode] = await tx
      .select()
      .from(episodes)
      .where(and(eq(episodes.seriesId, seriesId), eq(episodes.number, episodeNumber)));
    if (!episode) throw notFound(`Episode ${episodeNumber} not found`);

    const sceneRows = await tx
      .select()
      .from(scenes)
      .where(eq(scenes.episodeId, episode.id))
      .orderBy(asc(scenes.orderIndex));

    const cast = await tx
      .select()
      .from(characters)
      .where(eq(characters.seriesId, seriesId))
      .orderBy(asc(characters.createdAt));

    if (sceneRows.length === 0) {
      return { series: seriesRow, episode, scenes: [], characters: cast };
    }

    const shotRows = await tx
      .select({ shot: shots })
      .from(shots)
      .innerJoin(scenes, eq(scenes.id, shots.sceneId))
      .where(eq(scenes.episodeId, episode.id))
      .orderBy(asc(shots.sceneId), asc(shots.orderIndex));

    const allShots = shotRows.map((r) => r.shot);

    return {
      series: seriesRow,
      episode,
      characters: cast,
      scenes: sceneRows.map((scene) => ({
        scene,
        shots: allShots.filter((shot) => shot.sceneId === scene.id),
      })),
    };
  });
}

export async function loadStoryboard(
  userId: string,
  episodeId: string,
): Promise<StoryboardDetail> {
  return withUserDb(userId, async (tx) => {
    const [episode] = await tx.select().from(episodes).where(eq(episodes.id, episodeId));
    if (!episode) throw notFound('Episode not found');

    const sceneRows = await tx
      .select()
      .from(scenes)
      .where(eq(scenes.episodeId, episodeId))
      .orderBy(asc(scenes.orderIndex));

    const cast = await tx
      .select()
      .from(characters)
      .where(eq(characters.seriesId, episode.seriesId))
      .orderBy(asc(characters.createdAt));

    if (sceneRows.length === 0) return { scenes: [], characters: cast };

    const shotRows = await tx
      .select()
      .from(shots)
      .where(
        inArray(
          shots.sceneId,
          sceneRows.map((s) => s.id),
        ),
      )
      .orderBy(asc(shots.sceneId), asc(shots.orderIndex));

    return {
      characters: cast,
      scenes: sceneRows.map((scene) => ({
        scene,
        shots: shotRows.filter((shot) => shot.sceneId === scene.id),
      })),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Prompt composition against database rows                                   */
/* -------------------------------------------------------------------------- */

export interface ComposableShot {
  camera: string;
  action: string;
  characterIds: string[];
  promptOverride?: string | null;
}

export interface ComposableScene {
  location: string;
  timeOfDay: string;
}

/**
 * Bridges the database shape to the pure composer: resolves character ids to
 * their appearance text, in the order they appear on the shot.
 */
export function composePromptsForShot(
  shot: ComposableShot,
  scene: ComposableScene,
  cast: Character[],
  styleSuffix: string | null,
): { videoPrompt: string; imagePrompt: string; negativePrompt: string } {
  const byId = new Map(cast.map((c) => [c.id, c]));

  const promptCharacters: PromptCharacter[] = shot.characterIds
    .map((id) => byId.get(id))
    .filter((c): c is Character => Boolean(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      appearancePrompt: c.appearancePrompt,
      role: c.role,
    }));

  const input = {
    camera: shot.camera,
    action: shot.action,
    location: scene.location,
    timeOfDay: scene.timeOfDay,
    characters: promptCharacters,
    styleSuffix,
    override: shot.promptOverride ?? null,
  };

  return {
    videoPrompt: composeVideoPrompt(input),
    imagePrompt: composeImagePrompt(input),
    negativePrompt: composeNegativePrompt(),
  };
}

/* -------------------------------------------------------------------------- */
/* Persisting a generated storyboard                                          */
/* -------------------------------------------------------------------------- */

/**
 * Overrides are keyed by position — scene index and shot index within it.
 *
 * A regenerated storyboard is a different set of rows, so an override cannot be
 * carried by row id. Position is the only identity that survives, and it holds
 * for the common case (re-rolling coverage while the scene list is stable). If
 * a regeneration changes the shot count in a scene, later overrides in that
 * scene will land on a different shot — which is why the UI marks overridden
 * shots clearly.
 */
function overrideKey(sceneIndex: number, shotIndex: number): string {
  return `${sceneIndex}:${shotIndex}`;
}

async function collectOverrides(
  tx: Transaction,
  episodeId: string,
): Promise<Map<string, string>> {
  const sceneRows = await tx
    .select()
    .from(scenes)
    .where(eq(scenes.episodeId, episodeId))
    .orderBy(asc(scenes.orderIndex));

  if (sceneRows.length === 0) return new Map();

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

  const map = new Map<string, string>();
  for (const [sceneIndex, scene] of sceneRows.entries()) {
    const owned = shotRows
      .filter((s) => s.sceneId === scene.id)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    for (const [shotIndex, shot] of owned.entries()) {
      if (shot.promptOverride?.trim()) {
        map.set(overrideKey(sceneIndex, shotIndex), shot.promptOverride);
      }
    }
  }
  return map;
}

export interface PersistStoryboardInput {
  userId: string;
  episodeId: string;
  bible: Bible;
  script: Script;
  storyboard: Storyboard;
  episodeSeconds: number;
  /** Provider grid, injected so this stays testable and provider-agnostic. */
  clampDuration: (seconds: number) => number;
}

export interface PersistStoryboardResult {
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
  preservedOverrides: number;
}

export async function persistStoryboard(
  input: PersistStoryboardInput,
): Promise<PersistStoryboardResult> {
  const { bible, script, storyboard } = input;
  const styleSuffix = bible.visual_style ?? null;

  return withUserDb(input.userId, async (tx) => {
    const cast = await tx
      .select()
      .from(characters)
      .where(
        eq(
          characters.seriesId,
          (
            await tx
              .select({ seriesId: episodes.seriesId })
              .from(episodes)
              .where(eq(episodes.id, input.episodeId))
          )[0]?.seriesId ?? '',
        ),
      );

    const byName = new Map(cast.map((c) => [c.name.toLowerCase(), c]));
    const overrides = await collectOverrides(tx, input.episodeId);

    // Scenes cascade to shots and assets, so this clears the old board.
    await tx.delete(scenes).where(eq(scenes.episodeId, input.episodeId));

    // Flatten so durations are fitted against the whole episode, not per scene.
    const flat: Array<{
      sceneIndex: number;
      shotIndex: number;
      camera: string;
      action: string;
      dialogue: string | null;
      speakerId: string | null;
      characterIds: string[];
      requestedSeconds: number;
    }> = [];

    for (const [sceneIndex, scriptScene] of script.scenes.entries()) {
      const generated = storyboard.scenes.find((s) => s.scene_index === sceneIndex);
      const generatedShots = generated?.shots ?? [];

      // A scene the model skipped still needs coverage.
      const shotsForScene =
        generatedShots.length > 0
          ? generatedShots
          : [
              {
                camera: 'medium' as const,
                action: scriptScene.summary,
                dialogue: null,
                speaker: null,
                characters: [],
                duration_seconds: 5,
              },
            ];

      for (const [shotIndex, shot] of shotsForScene.entries()) {
        const speaker = shot.speaker ? byName.get(shot.speaker.toLowerCase()) : undefined;
        const characterIds = shot.characters
          .map((name) => byName.get(name.toLowerCase())?.id)
          .filter((id): id is string => Boolean(id));

        flat.push({
          sceneIndex,
          shotIndex,
          camera: normaliseCamera(shot.camera),
          action: shot.action,
          dialogue: shot.dialogue ?? null,
          speakerId: speaker?.id ?? null,
          characterIds,
          requestedSeconds: shot.duration_seconds,
        });
      }
    }

    const fitted = fitShotDurations(
      flat.map((s) => s.requestedSeconds),
      input.episodeSeconds,
      input.clampDuration,
    );

    let preservedOverrides = 0;

    for (const [sceneIndex, scriptScene] of script.scenes.entries()) {
      const [sceneRow] = await tx
        .insert(scenes)
        .values({
          episodeId: input.episodeId,
          orderIndex: sceneIndex,
          location: scriptScene.location,
          timeOfDay: scriptScene.time_of_day,
          summary: scriptScene.summary,
        })
        .returning();

      const owned = flat
        .map((shot, flatIndex) => ({ shot, flatIndex }))
        .filter(({ shot }) => shot.sceneIndex === sceneIndex);

      if (owned.length === 0) continue;

      await tx.insert(shots).values(
        owned.map(({ shot, flatIndex }) => {
          const override = overrides.get(overrideKey(sceneIndex, shot.shotIndex)) ?? null;
          if (override) preservedOverrides += 1;

          const prompts = composePromptsForShot(
            {
              camera: shot.camera,
              action: shot.action,
              characterIds: shot.characterIds,
              promptOverride: override,
            },
            { location: scriptScene.location, timeOfDay: scriptScene.time_of_day },
            cast,
            styleSuffix,
          );

          return {
            sceneId: sceneRow!.id,
            orderIndex: shot.shotIndex,
            durationSeconds: fitted[flatIndex] ?? shot.requestedSeconds,
            camera: shot.camera,
            action: shot.action,
            dialogue: shot.dialogue,
            speakerCharacterId: shot.speakerId,
            characterIds: shot.characterIds,
            imagePrompt: prompts.imagePrompt,
            videoPrompt: prompts.videoPrompt,
            negativePrompt: prompts.negativePrompt,
            promptOverride: override,
            status: 'pending' as const,
          };
        }),
      );
    }

    await tx
      .update(episodes)
      .set({ status: 'storyboarded' })
      .where(eq(episodes.id, input.episodeId));

    return {
      sceneCount: script.scenes.length,
      shotCount: flat.length,
      totalSeconds: fitted.reduce((a, b) => a + b, 0),
      preservedOverrides,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Recomposition after an edit                                                */
/* -------------------------------------------------------------------------- */

/**
 * The series-level style suffix every shot prompt ends with, resolved from a
 * scene. Shared by every editing route so they all compose identically.
 */
export async function styleSuffixForScene(
  tx: Transaction,
  sceneId: string,
): Promise<string | null> {
  const [scene] = await tx.select().from(scenes).where(eq(scenes.id, sceneId));
  if (!scene) return null;

  const [episode] = await tx.select().from(episodes).where(eq(episodes.id, scene.episodeId));
  if (!episode) return null;

  const [row] = await tx.select().from(series).where(eq(series.id, episode.seriesId));
  const bible = row?.bible as { visual_style?: string } | null;
  return bible?.visual_style ?? null;
}

/**
 * Recomposes the prompts for one shot from its current state. Called after any
 * edit that changes what the prompt should say — camera, action, cast, or the
 * character's own appearance text.
 */
export async function recomposeShot(
  tx: Transaction,
  shotId: string,
  styleSuffix: string | null,
): Promise<Shot | null> {
  const [shot] = await tx.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) return null;

  const [scene] = await tx.select().from(scenes).where(eq(scenes.id, shot.sceneId));
  if (!scene) return null;

  const [episode] = await tx.select().from(episodes).where(eq(episodes.id, scene.episodeId));
  if (!episode) return null;

  const cast = await tx
    .select()
    .from(characters)
    .where(eq(characters.seriesId, episode.seriesId));

  const prompts = composePromptsForShot(
    {
      camera: shot.camera,
      action: shot.action,
      characterIds: shot.characterIds,
      promptOverride: shot.promptOverride,
    },
    { location: scene.location, timeOfDay: scene.timeOfDay },
    cast,
    styleSuffix,
  );

  const [updated] = await tx
    .update(shots)
    .set({
      videoPrompt: prompts.videoPrompt,
      imagePrompt: prompts.imagePrompt,
      negativePrompt: prompts.negativePrompt,
    })
    .where(eq(shots.id, shotId))
    .returning();

  return updated ?? null;
}
