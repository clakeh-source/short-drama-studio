import { describe, expect, it } from 'vitest';
import { generateBible } from '@/lib/ai/bible';
import { generateScript, regenerateScene } from '@/lib/ai/script';
import { bibleSchema, scriptSchema, type CreateSeriesInput } from '@/lib/ai/schemas';
import { driftFromTarget, estimateScriptSeconds } from '@/lib/timing';
import { getLlmProvider } from '@/lib/providers';

/**
 * The Phase 1 pipeline against the stub provider — schema conformance, duration
 * budgeting and single-scene splicing, with no API key and no spend. The same
 * criteria are re-run against the real model by scripts/verify-phase1.mjs.
 */

const provider = getLlmProvider('stub');

const input: CreateSeriesInput = {
  premise: 'A hotel night manager recognises a guest she buried three months ago.',
  genre: 'Revenge',
  tone: 'Cold and controlled',
  audience: 'Adults 18-34',
  language: 'en',
  episodeCount: 6,
  episodeSeconds: 60,
};

describe('bible generation', () => {
  it('produces a bible that satisfies the schema', async () => {
    const { data, attempts } = await generateBible({ provider, input });

    expect(() => bibleSchema.parse(data)).not.toThrow();
    expect(attempts).toBe(1);
    expect(data.characters.length).toBeGreaterThanOrEqual(3);
    expect(data.characters.length).toBeLessThanOrEqual(6);
  });

  it('produces exactly the requested number of episodes, numbered from 1', async () => {
    const { data } = await generateBible({
      provider,
      input: { ...input, episodeCount: 9 },
    });

    expect(data.episodes).toHaveLength(9);
    expect(data.episodes.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('gives every character a substantial appearance prompt', async () => {
    const { data } = await generateBible({ provider, input });

    for (const character of data.characters) {
      expect(character.appearance_prompt.length).toBeGreaterThanOrEqual(20);
      // It must describe a person, not reference the story or the character.
      expect(character.appearance_prompt).not.toContain(character.name);
    }
  });

  it('streams deltas before it resolves', async () => {
    const deltas: string[] = [];
    await generateBible({
      provider,
      input,
      onDelta: (chunk) => {
        if (chunk.type === 'text') deltas.push(chunk.text);
      },
    });

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toContain('"title"');
  });
});

describe('script generation', () => {
  it('produces a script that satisfies the schema', async () => {
    const { data: bible } = await generateBible({ provider, input });
    const { data: script } = await generateScript({
      provider,
      bible,
      episodeNumber: 1,
      episodeSeconds: 60,
      language: 'en',
    });

    expect(() => scriptSchema.parse(script)).not.toThrow();
    expect(script.hook).toBeTruthy();
    expect(script.cliffhanger).toBeTruthy();
  });

  it.each([30, 60, 90, 120])(
    'lands within 15%% of a %ds target (Phase 1 AC #2)',
    async (targetSeconds) => {
      const { data: bible } = await generateBible({
        provider,
        input: { ...input, episodeSeconds: targetSeconds },
      });
      const { data: script } = await generateScript({
        provider,
        bible,
        episodeNumber: 1,
        episodeSeconds: targetSeconds,
        language: 'en',
      });

      const drift = driftFromTarget(script.scenes, targetSeconds);
      expect(
        drift,
        `estimated ${estimateScriptSeconds(script.scenes).toFixed(1)}s against ${targetSeconds}s`,
      ).toBeLessThanOrEqual(0.15);
    },
  );
});

describe('single-scene regeneration (Phase 1 AC #4)', () => {
  it('replaces only the target scene; every other scene is byte-identical', async () => {
    const { data: bible } = await generateBible({ provider, input });
    const { data: script } = await generateScript({
      provider,
      bible,
      episodeNumber: 1,
      episodeSeconds: 90,
      language: 'en',
    });

    expect(script.scenes.length).toBeGreaterThanOrEqual(3);
    const targetIndex = 2;
    const before = script.scenes.map((s) => JSON.stringify(s));

    const { data: replacement } = await regenerateScene({
      provider,
      bible,
      script,
      sceneIndex: targetIndex,
      episodeNumber: 1,
      language: 'en',
    });

    // The splice the API route performs.
    const next = {
      ...script,
      scenes: script.scenes.map((s, i) => (i === targetIndex ? replacement : s)),
    };
    const after = next.scenes.map((s) => JSON.stringify(s));

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      if (i === targetIndex) {
        expect(after[i], 'the target scene should have changed').not.toBe(before[i]);
      } else {
        expect(after[i], `scene ${i + 1} must be untouched`).toBe(before[i]);
      }
    }

    // The surrounding document is untouched too.
    expect(next.hook).toBe(script.hook);
    expect(next.cliffhanger).toBe(script.cliffhanger);
  });

  it('refuses an out-of-range scene index', async () => {
    const { data: bible } = await generateBible({ provider, input });
    const { data: script } = await generateScript({
      provider,
      bible,
      episodeNumber: 1,
      episodeSeconds: 60,
      language: 'en',
    });

    await expect(
      regenerateScene({
        provider,
        bible,
        script,
        sceneIndex: 99,
        episodeNumber: 1,
        language: 'en',
      }),
    ).rejects.toThrow(/out of range/);
  });
});
