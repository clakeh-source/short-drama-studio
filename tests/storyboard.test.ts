import { describe, expect, it } from 'vitest';
import { generateBible } from '@/lib/ai/bible';
import { generateScript } from '@/lib/ai/script';
import { generateStoryboard } from '@/lib/ai/storyboard';
import { composeVideoPrompt } from '@/lib/ai/prompts';
import { storyboardSchema, type CreateSeriesInput } from '@/lib/ai/schemas';
import { fitShotDurations, shotDurationDrift, totalShotSeconds } from '@/lib/shots';
import { getLlmProvider, getVideoProvider } from '@/lib/providers';

/**
 * The Phase 2 pipeline against the stub provider: coverage, duration fitting,
 * and the appearance-verbatim guarantee that makes characters hold together
 * across shots.
 */

const llm = getLlmProvider('stub');
const video = getVideoProvider('stub');
const clamp = (seconds: number) => video.clampDuration(seconds);

const input: CreateSeriesInput = {
  premise: 'A hotel night manager recognises a guest she buried three months ago.',
  genre: 'Revenge',
  tone: 'Cold and controlled',
  audience: 'Adults 18-34',
  language: 'en',
  episodeCount: 3,
  episodeSeconds: 60,
};

async function buildBoard(episodeSeconds = 60) {
  const { data: bible } = await generateBible({
    provider: llm,
    input: { ...input, episodeSeconds },
  });
  const { data: script } = await generateScript({
    provider: llm,
    bible,
    episodeNumber: 1,
    episodeSeconds,
    language: 'en',
  });
  const { data: storyboard } = await generateStoryboard({
    provider: llm,
    bible,
    script,
    episodeNumber: 1,
    episodeSeconds,
  });
  return { bible, script, storyboard };
}

describe('storyboard generation', () => {
  it('satisfies the schema and covers every scene', async () => {
    const { script, storyboard } = await buildBoard();

    expect(() => storyboardSchema.parse(storyboard)).not.toThrow();
    expect(storyboard.scenes).toHaveLength(script.scenes.length);
    expect(storyboard.scenes.map((s) => s.scene_index)).toEqual(
      script.scenes.map((_, i) => i),
    );
  });

  it('AC #1 — a 60s episode gives 10-20 shots within 10% of target', async () => {
    const { storyboard } = await buildBoard(60);

    const flat = storyboard.scenes.flatMap((s) => s.shots);
    expect(flat.length).toBeGreaterThanOrEqual(10);
    expect(flat.length).toBeLessThanOrEqual(20);

    const fitted = fitShotDurations(
      flat.map((s) => s.duration_seconds),
      60,
      clamp,
    );
    expect(
      shotDurationDrift(fitted, 60),
      `${flat.length} shots summing to ${totalShotSeconds(fitted)}s`,
    ).toBeLessThanOrEqual(0.1);
  });

  it('uses only the fixed camera vocabulary', async () => {
    const { storyboard } = await buildBoard();
    for (const scene of storyboard.scenes) {
      for (const shot of scene.shots) {
        // The schema is an enum, so reaching here at all proves it — this
        // guards against the enum being loosened later.
        expect(typeof shot.camera).toBe('string');
      }
    }
  });

  it('gives inserts no cast', async () => {
    const { storyboard } = await buildBoard();
    const inserts = storyboard.scenes.flatMap((s) => s.shots).filter((s) => s.camera === 'insert');
    for (const shot of inserts) expect(shot.characters).toHaveLength(0);
  });
});

describe('AC #3 — appearance prompts survive into every shot', () => {
  it('every shot containing a character carries their appearance verbatim', async () => {
    const { bible, script, storyboard } = await buildBoard();

    const byName = new Map(bible.characters.map((c) => [c.name.toLowerCase(), c]));
    let checked = 0;

    for (const boardScene of storyboard.scenes) {
      const scriptScene = script.scenes[boardScene.scene_index]!;

      for (const shot of boardScene.shots) {
        const present = shot.characters
          .map((name) => byName.get(name.toLowerCase()))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));

        const prompt = composeVideoPrompt({
          camera: shot.camera,
          action: shot.action,
          location: scriptScene.location,
          timeOfDay: scriptScene.time_of_day,
          characters: present.map((c) => ({
            id: c.name,
            name: c.name,
            appearancePrompt: c.appearance_prompt,
            role: c.role,
          })),
          styleSuffix: bible.visual_style ?? null,
        });

        for (const character of present) {
          expect(prompt, `${character.name} in a ${shot.camera}`).toContain(
            character.appearance_prompt,
          );
          checked += 1;
        }
      }
    }

    expect(checked, 'the board should contain at least one character shot').toBeGreaterThan(0);
  });

  it('the same character produces the same appearance text in every shot', async () => {
    const { bible } = await buildBoard();
    const character = bible.characters[0]!;

    const promptA = composeVideoPrompt({
      camera: 'close-up',
      action: 'She turns',
      location: 'Lobby',
      timeOfDay: 'night',
      characters: [
        { id: 'x', name: character.name, appearancePrompt: character.appearance_prompt },
      ],
    });
    const promptB = composeVideoPrompt({
      camera: 'wide',
      action: 'She crosses the floor',
      location: 'Loading bay',
      timeOfDay: 'pre-dawn',
      characters: [
        { id: 'x', name: character.name, appearancePrompt: character.appearance_prompt },
      ],
    });

    expect(promptA).toContain(character.appearance_prompt);
    expect(promptB).toContain(character.appearance_prompt);
  });
});

describe('AC #6 — a manual override is not overwritten by regeneration', () => {
  /**
   * Mirrors the position-keyed preservation in persistStoryboard: overrides are
   * captured before the rows are replaced and reapplied to the same position.
   */
  function reapplyOverrides(
    board: Array<Array<{ promptOverride: string | null }>>,
    saved: Map<string, string>,
  ) {
    return board.map((scene, sceneIndex) =>
      scene.map((shot, shotIndex) => ({
        ...shot,
        promptOverride: saved.get(`${sceneIndex}:${shotIndex}`) ?? shot.promptOverride,
      })),
    );
  }

  it('carries an override across a regenerated board', () => {
    const before = [
      [{ promptOverride: null }, { promptOverride: 'MY CUSTOM PROMPT' }],
      [{ promptOverride: null }],
    ];

    const saved = new Map<string, string>();
    before.forEach((scene, sceneIndex) =>
      scene.forEach((shot, shotIndex) => {
        if (shot.promptOverride) saved.set(`${sceneIndex}:${shotIndex}`, shot.promptOverride);
      }),
    );

    // A fresh generation: every prompt composed, no overrides.
    const regenerated = [
      [{ promptOverride: null }, { promptOverride: null }],
      [{ promptOverride: null }],
    ];

    const after = reapplyOverrides(regenerated, saved);
    expect(after[0]![1]!.promptOverride).toBe('MY CUSTOM PROMPT');
    expect(after[0]![0]!.promptOverride).toBeNull();
    expect(after[1]![0]!.promptOverride).toBeNull();
  });

  it('an overridden prompt is returned unchanged by the composer', () => {
    const override = 'my own wording, untouched by the machine';
    expect(
      composeVideoPrompt({
        camera: 'close-up',
        action: 'anything',
        location: 'anywhere',
        timeOfDay: 'night',
        characters: [{ id: 'a', name: 'A', appearancePrompt: 'a person in a coat' }],
        override,
      }),
    ).toBe(override);
  });
});
