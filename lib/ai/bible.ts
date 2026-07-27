import 'server-only';

import type { LlmProvider, LlmStreamChunk } from '@/lib/providers';
import { streamJson } from './json';
import { bibleSchema, type Bible, type CreateSeriesInput } from './schemas';
import { inputBlock, JSON_RULES, SAFETY_RULES, STRUCTURE_RULES, VISUAL_RULES } from './prompts/rules';

const SYSTEM = `You are a series developer for vertical short-form drama — the 60-to-90 second,
9:16, cliffhanger-per-episode format that runs on ShortMax, ReelShort and DramaBox.

You are writing a series bible: the document a small crew shoots from. It has to be
specific enough that two different writers produce compatible episodes from it.

${STRUCTURE_RULES}

${VISUAL_RULES}

${SAFETY_RULES}

WRITE LIKE A PROFESSIONAL, NOT A PITCH DECK:
- The logline states who wants what and what stands in the way. One sentence.
- Tone rules are operational constraints a writer can violate, not adjectives.
  "Money is never named directly" is a rule. "Gritty and emotional" is not.
- Character descriptions carry a want and a lie they tell. Not a biography.
- Episode synopses each end on the reversal or the cliffhanger, not a summary.

${JSON_RULES}

LENGTH BUDGETS — stay well inside these; overrunning fails validation:
- logline: one sentence, under 200 characters
- world: 2-4 sentences, under 800 characters
- tone_rules: one short imperative each, under 120 characters
- description: 1-2 sentences, under 300 characters
- appearance_prompt: a single comma-separated visual list, under 400 characters
- season_arc: 2-4 sentences, under 800 characters
- episode synopsis: 1-2 sentences, under 300 characters

Schema:
{
  "title": string,
  "logline": string,
  "world": string,
  "tone_rules": string[],           // 2-10 operational rules
  "characters": [                   // 3-6 characters
    { "name": string, "role": string, "description": string, "appearance_prompt": string }
  ],
  "season_arc": string,
  "episodes": [                     // exactly episodeCount entries
    { "number": number, "title": string, "synopsis": string }
  ]
}`;

export interface GenerateBibleOptions {
  provider: LlmProvider;
  input: CreateSeriesInput;
  onDelta?: (chunk: LlmStreamChunk) => void;
}

export async function generateBible(options: GenerateBibleOptions) {
  const { input } = options;

  const prompt = `Develop the series bible for this premise.

${inputBlock({
  premise: input.premise,
  genre: input.genre,
  tone: input.tone,
  audience: input.audience,
  language: input.language,
  episodeCount: input.episodeCount,
  episodeSeconds: input.episodeSeconds,
})}

Produce exactly ${input.episodeCount} episode ${
    input.episodeCount === 1 ? 'entry' : 'entries'
  }, numbered 1 to ${input.episodeCount}. Each episode is about ${input.episodeSeconds} seconds of
screen time, so a synopsis covers one turn of the screw, not a chapter.

Write in ${input.language}. Aim at a ${input.audience} audience. Genre: ${input.genre}. Tone: ${input.tone}.`;

  return streamJson<Bible>({
    provider: options.provider,
    operation: 'bible.generate',
    system: SYSTEM,
    prompt,
    schema: bibleSchema,
    maxTokens: 24_000,
    effort: 'low',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  });
}
