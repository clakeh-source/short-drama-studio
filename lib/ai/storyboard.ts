import 'server-only';

import type { LlmProvider, LlmStreamChunk } from '@/lib/providers';
import { fitShotCount, MAX_SHOT_SECONDS, MIN_SHOT_SECONDS, shotCountRange } from '@/lib/shots';
import { LLM_BUDGETS } from './budget';
import { streamJson } from './json';
import { storyboardSchema, type Bible, type Script, type Storyboard } from './schemas';
import { CAMERA_VOCABULARY } from './prompts';
import { inputBlock, JSON_RULES, SAFETY_RULES } from './prompts/rules';

/**
 * Scene → shots.
 *
 * The model decides coverage — how to cut a scene, which camera serves which
 * beat, who is in frame. It does **not** decide the final durations (refitted
 * to the provider grid and the episode budget by lib/shots.ts) and it does not
 * write the video prompts (composed deterministically by lib/ai/prompts.ts).
 */

const SYSTEM = `You are a director breaking a vertical short-drama script into shots.

Each shot is one continuous camera setup, generated as a single video clip. Every
beat becomes one or more shots; a beat with a long line may need two.

CAMERA VOCABULARY — use these exact strings and nothing else:
${CAMERA_VOCABULARY.map((c) => `- ${c}`).join('\n')}

HOW TO COVER A SCENE:
- Open a scene on the widest framing you will use, then push in as it escalates.
- Dialogue: cut to the speaker for the line, or to the listener for the reaction.
  Alternate. Never sit on one framing for two consecutive shots.
- "insert" is for objects — a register, a phone screen, a hand on a door. Inserts
  carry no characters.
- "POV" is what a named character sees; they are not in their own POV shot.
- Vertical framing means faces and hands. Wides are establishing beats, not the
  default.

WHO IS IN FRAME:
List only characters actually visible in that shot, by their exact name from the
cast list. An over-shoulder has two. A close-up usually has one. An insert has
none. This list decides which appearance descriptions get baked into the clip, so
being loose here makes people change faces between shots.

DURATION:
${MIN_SHOT_SECONDS}-${MAX_SHOT_SECONDS} seconds per shot. Dialogue plays at 2.5 words per second — give a line
enough room, plus about a second of air. Silent reaction shots are 3 seconds.

${SAFETY_RULES}

${JSON_RULES}

Schema:
{
  "scenes": [
    {
      "scene_index": number,          // matches the input scene index
      "shots": [
        {
          "camera": string,           // exactly one of the vocabulary above
          "action": string,           // what happens, visually
          "dialogue": string | null,
          "speaker": string | null,   // exact cast name, or null
          "characters": string[],     // exact cast names visible in frame
          "duration_seconds": number
        }
      ]
    }
  ]
}`;

export interface GenerateStoryboardOptions {
  provider: LlmProvider;
  bible: Bible;
  script: Script;
  episodeNumber: number;
  episodeSeconds: number;
  onDelta?: (chunk: LlmStreamChunk) => void;
}

export async function generateStoryboard(options: GenerateStoryboardOptions) {
  const { bible, script, episodeSeconds } = options;
  const { min, max } = shotCountRange(episodeSeconds);

  const scenesForPrompt = script.scenes.map((scene, index) => ({
    scene_index: index,
    location: scene.location,
    time_of_day: scene.time_of_day,
    summary: scene.summary,
    beats: scene.beats.map((beat) => ({
      action: beat.action,
      dialogue: beat.dialogue ?? null,
      speaker: beat.speaker ?? null,
    })),
  }));

  const prompt = `Break episode ${options.episodeNumber} of "${bible.title}" into shots.

${inputBlock({
  episodeNumber: options.episodeNumber,
  episodeSeconds,
  minShots: min,
  maxShots: max,
  scenes: scenesForPrompt,
})}

CAST — use these names exactly:
${bible.characters.map((c) => `- ${c.name} (${c.role})`).join('\n')}

TONE RULES:
${bible.tone_rules.map((r) => `- ${r}`).join('\n')}

Cover every scene, in order, and return one entry per scene with its
\`scene_index\`. Produce between ${min} and ${max} shots in total across the whole
episode, summing to about ${episodeSeconds} seconds.`;

  const result = await streamJson<Storyboard>({
    provider: options.provider,
    operation: 'storyboard.generate',
    system: SYSTEM,
    prompt,
    schema: storyboardSchema,
    maxTokens: LLM_BUDGETS['storyboard.generate'],
    effort: 'low',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  });

  // The prompt asks for a shot count in range; this makes it true. Models
  // over-cover — the first stub run returned 26 shots for a 60s episode — and
  // the count is a product constraint, not a suggestion.
  const fitted = fitShotCount(result.data.scenes, { min, max });

  return {
    ...result,
    data: {
      scenes: result.data.scenes.map((scene, index) => ({
        scene_index: scene.scene_index,
        shots: fitted[index]?.shots ?? scene.shots,
      })),
    },
  };
}
