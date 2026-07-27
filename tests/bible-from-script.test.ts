import { describe, expect, it } from 'vitest';
import { deriveBibleFromScript } from '@/lib/ai/bible-from-script';
import type { ParsedEpisode } from '@/lib/script-import/parse';
import type { LlmGenerateInput, LlmProvider, LlmStreamChunk, LlmUsage } from '@/lib/providers';

/**
 * The cast derived for an imported script must be named *exactly* as the script
 * names its speakers. `persistStoryboard` resolves a shot's characters by
 * matching `speaker` against `characters.name`; a model that helpfully tidied
 * "NADIA" into "Nadia Voss" would produce shots with no characters attached, no
 * appearance text in the prompt and no voice to synthesise — and nothing would
 * fail loudly. These tests are the guard on that.
 */

function providerReturning(payload: unknown): LlmProvider {
  return {
    id: 'scripted',
    model: 'scripted-v1',
    estimateCostCents: () => 1,
    async *stream(_input: LlmGenerateInput): AsyncGenerator<LlmStreamChunk, LlmUsage, void> {
      yield { type: 'text', text: JSON.stringify(payload) };
      return { tokensIn: 10, tokensOut: 5, costCents: 1 };
    },
  };
}

const EPISODES: ParsedEpisode[] = [
  {
    number: 1,
    title: 'The Wrong Name',
    warnings: [],
    script: {
      hook: 'My name is on this.',
      cliffhanger: 'Put it back.',
      scenes: [
        {
          location: 'CORRIDOR',
          time_of_day: 'NIGHT',
          summary: 'Nadia reads the document.',
          beats: [
            { action: 'She reads it.', dialogue: 'My name is on this.', speaker: 'NADIA' },
            { action: 'Priya arrives.', dialogue: 'Put it back.', speaker: 'PRIYA' },
          ],
        },
      ],
    },
  },
];

const base = {
  title: 'The Wrong Name',
  logline: 'A cleaner finds her own name in a sealed settlement.',
  world: 'A law firm after hours.',
  tone_rules: ['Money is never named directly', 'Nobody raises their voice'],
  season_arc: 'She trades the document for the truth.',
  visual_style: 'cold fluorescent, desaturated, handheld',
  episode_titles: [{ number: 1, title: 'The Wrong Name', synopsis: 'She finds the document.' }],
};

const appearance = 'woman, mid thirties, dark hair to the jaw, charcoal shirt, dark trousers';

describe('deriveBibleFromScript', () => {
  it('keeps the script’s speaker names even when the model renames them', async () => {
    const provider = providerReturning({
      ...base,
      characters: [
        { name: 'Nadia Voss', role: 'Cleaner', description: 'Wants the truth.', appearance_prompt: appearance },
        { name: 'Priya Shen', role: 'Manager', description: 'Wants it buried.', appearance_prompt: appearance },
      ],
    });

    const result = await deriveBibleFromScript({
      provider,
      episodes: EPISODES,
      speakers: ['NADIA', 'PRIYA'],
      language: 'en',
      episodeSeconds: 60,
    });

    // Matched case-insensitively, then forced back to what the script says.
    expect(result.bible.characters.map((c) => c.name)).toEqual(['NADIA', 'PRIYA']);
    expect(result.bible.characters[0]!.role).toBe('Cleaner');
    expect(result.placeholders).toEqual([]);
  });

  it('fills in a speaker the model skipped, and reports it', async () => {
    const provider = providerReturning({
      ...base,
      characters: [
        { name: 'NADIA', role: 'Cleaner', description: 'Wants the truth.', appearance_prompt: appearance },
      ],
    });

    const result = await deriveBibleFromScript({
      provider,
      episodes: EPISODES,
      speakers: ['NADIA', 'PRIYA'],
      language: 'en',
      episodeSeconds: 60,
    });

    expect(result.bible.characters.map((c) => c.name)).toEqual(['NADIA', 'PRIYA']);
    // Usable rather than correct: the pipeline runs, and the user is told.
    expect(result.bible.characters[1]!.appearance_prompt.length).toBeGreaterThanOrEqual(20);
    expect(result.placeholders).toEqual(['PRIYA']);
  });

  it('drops a character the model invented that nobody speaks', async () => {
    const provider = providerReturning({
      ...base,
      characters: [
        { name: 'NADIA', role: 'Cleaner', description: 'Wants the truth.', appearance_prompt: appearance },
        { name: 'PRIYA', role: 'Manager', description: 'Wants it buried.', appearance_prompt: appearance },
        { name: 'THE SENIOR PARTNER', role: 'Villain', description: 'Invented.', appearance_prompt: appearance },
      ],
    });

    const result = await deriveBibleFromScript({
      provider,
      episodes: EPISODES,
      speakers: ['NADIA', 'PRIYA'],
      language: 'en',
      episodeSeconds: 60,
    });

    expect(result.bible.characters.map((c) => c.name)).toEqual(['NADIA', 'PRIYA']);
  });

  it('gives a script with no dialogue a cast anyway, so the pipeline still runs', async () => {
    const provider = providerReturning({ ...base, characters: [] });

    const result = await deriveBibleFromScript({
      provider,
      episodes: EPISODES,
      speakers: [],
      language: 'en',
      episodeSeconds: 60,
    });

    expect(result.bible.characters).toHaveLength(1);
    expect(result.placeholders).toEqual(['Performer']);
  });

  it('produces one bible episode per parsed episode, with matching numbers', async () => {
    const provider = providerReturning({
      ...base,
      // Deliberately missing episode 2 to prove the fallback covers it.
      characters: [
        { name: 'NADIA', role: 'Cleaner', description: 'Wants the truth.', appearance_prompt: appearance },
      ],
    });

    const result = await deriveBibleFromScript({
      provider,
      episodes: [...EPISODES, { ...EPISODES[0]!, number: 2, title: 'Initialled' }],
      speakers: ['NADIA'],
      language: 'en',
      episodeSeconds: 60,
    });

    expect(result.bible.episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(result.bible.episodes[1]!.title).toBe('Initialled');
  });
});
