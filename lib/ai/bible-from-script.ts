import 'server-only';

import { z } from 'zod';
import type { LlmProvider, LlmStreamChunk } from '@/lib/providers';
import type { ParsedEpisode } from '@/lib/script-import/parse';
import { LLM_BUDGETS } from './budget';
import { streamJson } from './json';
import { bibleCharacterSchema, bibleSchema, type Bible } from './schemas';
import { JSON_RULES, SAFETY_RULES, VISUAL_RULES } from './prompts/rules';

/**
 * Builds a series bible for a script the user wrote.
 *
 * The generated path invents a cast and then writes episodes around it; here the
 * script already exists and the cast is whoever speaks in it. So the model is
 * asked only for what it cannot read off the page — how each character *looks*,
 * the world, the tone rules — and the names are then forced to match the parsed
 * speakers exactly.
 *
 * That last part is not a nicety. `persistStoryboard` resolves a shot's cast by
 * matching `speaker` against `characters.name`; a model that tidied "NADIA" into
 * "Nadia Voss" would silently produce shots with no characters attached, no
 * appearance in the prompt, and no voice to synthesise.
 */

const responseSchema = z.object({
  title: z.string().min(1).max(120),
  logline: z.string().min(1).max(500),
  world: z.string().min(1).max(3000),
  tone_rules: z.array(z.string().min(1).max(400)).min(2).max(10),
  season_arc: z.string().min(1).max(3000),
  visual_style: z.string().min(1).max(400),
  // No minimum: a script with no attributed dialogue has no cast to describe,
  // and rejecting the model's honest empty answer would just burn retries. The
  // assembly step below guarantees the bible ends up with someone in it.
  characters: z.array(bibleCharacterSchema).max(12),
  episode_titles: z
    .array(z.object({ number: z.int().min(1), title: z.string().min(1).max(120), synopsis: z.string().min(1).max(1500) }))
    .min(1)
    .max(50),
});

type DerivedResponse = z.infer<typeof responseSchema>;

const SYSTEM = `You are a series developer preparing someone else's script to be shot as vertical
short-form drama — 9:16, one cliffhanger per episode.

The script is written. You are NOT rewriting it. You are producing the production
document that sits beside it: how the world looks, how each character looks, and the
rules a crew shoots by.

${VISUAL_RULES}

${SAFETY_RULES}

READ, DO NOT INVENT:
- Every character you describe must be a speaker from the script, named EXACTLY as the
  script names them. Do not rename, expand, tidy or merge names. "NADIA" stays "NADIA".
- Infer appearance from what the script implies — age, status, job, era. Where the
  script says nothing, choose something plain and consistent rather than striking.
- Tone rules and world must describe the script that exists, not one you would prefer.
- Episode titles and synopses must describe what actually happens in that episode.

${JSON_RULES}

LENGTH BUDGETS — overrunning fails validation:
- logline: one sentence, under 200 characters
- world: 2-4 sentences, under 800 characters
- tone_rules: one short imperative each, under 120 characters
- description: 1-2 sentences, under 300 characters
- appearance_prompt: a single comma-separated visual list, under 400 characters
- visual_style: one comma-separated list of look and grade, under 200 characters
- synopsis: 1-2 sentences, under 300 characters

Schema:
{
  "title": string,
  "logline": string,
  "world": string,
  "tone_rules": string[],
  "season_arc": string,
  "visual_style": string,
  "characters": [
    { "name": string, "role": string, "description": string, "appearance_prompt": string }
  ],
  "episode_titles": [ { "number": number, "title": string, "synopsis": string } ]
}`;

/**
 * A neutral, reusable description for a speaker the model failed to cover.
 *
 * Deliberately unremarkable: it keeps the pipeline working and is obviously
 * placeholder text, so the user edits it rather than shipping it by accident.
 * Must clear `appearance_prompt`'s 20-character minimum.
 */
function placeholderAppearance(): string {
  return 'adult, average build, shoulder-length dark hair, plain contemporary clothing, neutral expression';
}

/** A compact rendering of the script — enough to characterise, not the whole text. */
function digest(episodes: ParsedEpisode[]): string {
  return episodes
    .map((episode) => {
      const scenes = episode.script.scenes
        .map((scene, i) => {
          const lines = scene.beats
            .filter((b) => b.dialogue)
            .slice(0, 4)
            .map((b) => `    ${b.speaker ?? '?'}: ${b.dialogue}`)
            .join('\n');
          return `  Scene ${i + 1} — ${scene.location}, ${scene.time_of_day}: ${scene.summary}${
            lines ? `\n${lines}` : ''
          }`;
        })
        .join('\n');
      return `EPISODE ${episode.number}${episode.title ? ` — ${episode.title}` : ''}\n${scenes}`;
    })
    .join('\n\n');
}

export interface DeriveBibleOptions {
  provider: LlmProvider;
  episodes: ParsedEpisode[];
  /** Distinct speakers, exactly as the parser found them. */
  speakers: string[];
  language: string;
  episodeSeconds: number;
  onDelta?: (chunk: LlmStreamChunk) => void;
}

export interface DeriveBibleResult {
  bible: Bible;
  /** Speakers the model did not describe, left with placeholder appearances. */
  placeholders: string[];
  usage: { tokensIn: number; tokensOut: number; costCents: number };
  attempts: number;
}

export async function deriveBibleFromScript(
  options: DeriveBibleOptions,
): Promise<DeriveBibleResult> {
  const { episodes, speakers } = options;

  const prompt = `Prepare the production bible for this script.

SPEAKERS — describe exactly these, under exactly these names:
${speakers.length ? speakers.map((s) => `- ${s}`).join('\n') : '- (none: the script has no dialogue)'}

EPISODES — produce one entry per episode, with these numbers:
${episodes.map((e) => `- ${e.number}${e.title ? ` (working title: ${e.title})` : ''}`).join('\n')}

Each episode runs about ${options.episodeSeconds} seconds of screen time.

THE SCRIPT:
${digest(episodes)}

Write in ${options.language}.`;

  const result = await streamJson<DerivedResponse>({
    provider: options.provider,
    operation: 'bible.derive',
    system: SYSTEM,
    prompt,
    schema: responseSchema,
    maxTokens: LLM_BUDGETS['bible.derive'],
    effort: 'low',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  });

  const placeholders: string[] = [];
  const normalise = (name: string) => name.trim().toLowerCase();

  /**
   * Finds the model's entry for a speaker.
   *
   * Exact first. Then a looser pass, because a script cues a character as
   * "NADIA" while a bible naturally writes "Nadia Voss" — the description is
   * still hers, and discarding it over a surname would swap real appearance
   * text for a placeholder. The looser pass is anchored at the start of the
   * name so "NADIA" cannot capture "PRIYA'S NADIA-LIKE ASSISTANT".
   */
  const findEntry = (speaker: string) => {
    const target = normalise(speaker);
    const exact = result.data.characters.find((c) => normalise(c.name) === target);
    if (exact) return exact;

    return result.data.characters.find((c) => {
      const candidate = normalise(c.name);
      return candidate.startsWith(`${target} `) || target.startsWith(`${candidate} `);
    });
  };

  /**
   * The cast is the speaker list, not the model's list. Anything the model added
   * that nobody speaks is dropped; anything it missed is filled in.
   */
  const characters = speakers.map((speaker) => {
    const matched = findEntry(speaker);
    if (matched) return { ...matched, name: speaker };
    placeholders.push(speaker);
    return {
      name: speaker,
      role: 'Unspecified',
      description: 'Imported from the script; no description was derived.',
      appearance_prompt: placeholderAppearance(),
    };
  });

  // A script with no dialogue still needs someone on screen for the pipeline to
  // have a cast at all.
  if (characters.length === 0) {
    characters.push({
      name: 'Performer',
      role: 'Unspecified',
      description: 'Placeholder for a script with no attributed dialogue.',
      appearance_prompt: placeholderAppearance(),
    });
    placeholders.push('Performer');
  }

  const titles = new Map(result.data.episode_titles.map((e) => [e.number, e]));

  const bible: Bible = {
    title: result.data.title,
    logline: result.data.logline,
    world: result.data.world,
    tone_rules: result.data.tone_rules,
    season_arc: result.data.season_arc,
    visual_style: result.data.visual_style,
    characters,
    episodes: episodes.map((episode) => {
      const entry = titles.get(episode.number);
      return {
        number: episode.number,
        title: entry?.title ?? episode.title ?? `Episode ${episode.number}`,
        synopsis: entry?.synopsis ?? episode.script.scenes[0]?.summary ?? 'Imported episode.',
      };
    }),
  };

  // Assembled by hand, so prove it satisfies the same contract the generated
  // path produces before anything downstream sees it.
  return {
    bible: bibleSchema.parse(bible),
    placeholders,
    usage: result.usage,
    attempts: result.attempts,
  };
}
