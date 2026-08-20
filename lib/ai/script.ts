import 'server-only';

import type { LlmProvider, LlmStreamChunk } from '@/lib/providers';
import {
  dialogueWordBudget,
  driftFromTarget,
  estimateScriptSeconds,
  scriptShape,
  TYPICAL_BEAT_SECONDS,
} from '@/lib/timing';
import { LLM_BUDGETS } from './budget';
import { streamJson } from './json';
import { sceneSchema, scriptSchema, type Bible, type Scene, type Script } from './schemas';
import { inputBlock, JSON_RULES, SAFETY_RULES, STRUCTURE_RULES } from './prompts/rules';

const SYSTEM = `You are a staff writer on a vertical short-form drama. You write the shooting
script for one episode: scenes, and inside each scene an ordered list of beats.

A beat is one filmable moment — an action, optionally with one line of dialogue.
It maps one-to-one onto a shot later, so keep each beat to a single idea.

${STRUCTURE_RULES}

${SAFETY_RULES}

TIMING IS A HARD CONSTRAINT:
Dialogue plays at 2.5 words per second. A silent action beat costs 2 seconds. A beat
with dialogue costs its words divided by 2.5, plus half a second of staging. Budget
against those numbers — an episode that overruns gets cut, and the cut is not yours.

${JSON_RULES}

LENGTH BUDGETS — overrunning fails validation:
- hook and cliffhanger: one line each, under 200 characters
- scene summary: one sentence, under 300 characters
- action: one sentence, under 300 characters
- dialogue: under 12 words

Schema:
{
  "hook": string,                   // what lands in the first 3 seconds
  "cliffhanger": string,            // the final line of the episode
  "scenes": [
    {
      "location": string,
      "time_of_day": string,
      "summary": string,
      "beats": [
        { "action": string, "dialogue": string | null, "speaker": string | null }
      ]
    }
  ]
}

"speaker" must exactly match a character name from the bible, or be null when the
beat has no dialogue.`;

function castBlock(bible: Bible): string {
  return bible.characters
    .map((c) => `- ${c.name} (${c.role}): ${c.description}`)
    .join('\n');
}

export interface GenerateScriptOptions {
  provider: LlmProvider;
  bible: Bible;
  episodeNumber: number;
  episodeSeconds: number;
  language: string;
  /** Compact recap of episodes 1..N-1 so serialization holds (Phase 5). */
  continuitySummary?: string;
  onDelta?: (chunk: LlmStreamChunk) => void;
}

export async function generateScript(options: GenerateScriptOptions) {
  const { bible, episodeNumber, episodeSeconds } = options;
  const episode = bible.episodes.find((e) => e.number === episodeNumber);
  const shape = scriptShape(episodeSeconds);

  const prompt = `Write episode ${episodeNumber} of "${bible.title}".

${inputBlock({
  episodeNumber,
  episodeSeconds,
  language: options.language,
  title: episode?.title ?? '',
  synopsis: episode?.synopsis ?? '',
  characters: bible.characters.map((c) => c.name),
})}

LOGLINE: ${bible.logline}

WORLD: ${bible.world}

TONE RULES:
${bible.tone_rules.map((r) => `- ${r}`).join('\n')}

CAST:
${castBlock(bible)}

SEASON ARC: ${bible.season_arc}

THIS EPISODE: ${episode?.title ?? `Episode ${episodeNumber}`} — ${
    episode?.synopsis ?? 'Advance the arc by one turn.'
  }
${options.continuitySummary ? `\nWHAT HAS HAPPENED SO FAR:\n${options.continuitySummary}\n` : ''}
TARGET LENGTH: ${episodeSeconds} seconds — roughly ${dialogueWordBudget(
    episodeSeconds,
  )} words of dialogue in total.

STRUCTURE — hit these counts exactly; they are how the episode reaches its length:
- exactly ${shape.scenes} ${shape.scenes === 1 ? 'scene' : 'scenes'}
- ${shape.beatsPerScene.min}-${shape.beatsPerScene.max} beats in each scene
- about ${shape.totalBeats} beats in total across the episode

Write in ${options.language}.`;

  const result = await streamJson<Script>({
    provider: options.provider,
    operation: 'script.generate',
    system: SYSTEM,
    prompt,
    schema: scriptSchema,
    maxTokens: LLM_BUDGETS['script.generate'],
    effort: 'low',
    // Three attempts: the duration check below is a real second chance, not a
    // formality, and the model corrects well when given the measured number.
    maxAttempts: 3,
    validate: (script) => {
      const drift = driftFromTarget(script.scenes, episodeSeconds);
      if (drift <= 0.15) return null;

      const actual = estimateScriptSeconds(script.scenes);
      const beats = script.scenes.reduce((n, s) => n + s.beats.length, 0);
      const direction = actual < episodeSeconds ? 'too short' : 'too long';
      const needed = Math.round((episodeSeconds - actual) / TYPICAL_BEAT_SECONDS);

      return (
        `That script runs about ${actual.toFixed(0)} seconds, but the episode has to be ` +
        `${episodeSeconds} seconds — ${(drift * 100).toFixed(0)}% ${direction}. ` +
        `You wrote ${script.scenes.length} scene(s) and ${beats} beats. ` +
        (needed > 0
          ? `Add roughly ${needed} more beats, spread across ${shape.scenes} scenes, to reach the length. `
          : `Cut roughly ${Math.abs(needed)} beats. `) +
        `Dialogue plays at 2.5 words per second and a silent beat costs 2 seconds.`
      );
    },
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  });

  /**
   * The composed prompt comes back with the result so continuity is verifiable
   * against what was actually sent, not against what the model happened to write
   * (Phase 5 AC #1). Asserting on model output would make the test a measure of
   * the model's mood; asserting on the payload measures our code.
   */
  return { ...result, prompt, continuitySummary: options.continuitySummary ?? '' };
}

/* -------------------------------------------------------------------------- */
/* Single-scene regeneration                                                  */
/* -------------------------------------------------------------------------- */

export interface RegenerateSceneOptions {
  provider: LlmProvider;
  bible: Bible;
  script: Script;
  /** Zero-based index into script.scenes. */
  sceneIndex: number;
  episodeNumber: number;
  language: string;
  /** Optional steer from the user: "make it colder", "cut the second beat". */
  note?: string;
  onDelta?: (chunk: LlmStreamChunk) => void;
}

/**
 * Rewrites exactly one scene. The caller splices the result back in, so scenes
 * either side are untouched byte-for-byte — Phase 1 AC #4.
 */
export async function regenerateScene(options: RegenerateSceneOptions) {
  const { bible, script, sceneIndex } = options;
  const target = script.scenes[sceneIndex];
  if (!target) {
    throw new Error(`Scene index ${sceneIndex} is out of range.`);
  }

  const before = script.scenes[sceneIndex - 1];
  const after = script.scenes[sceneIndex + 1];

  const prompt = `Rewrite scene ${sceneIndex + 1} of episode ${options.episodeNumber} of "${bible.title}".

${inputBlock({
  sceneIndex,
  episodeNumber: options.episodeNumber,
  language: options.language,
})}

Return ONE scene object — not the whole script. It must slot in where the current
scene sits without breaking continuity on either side.

CAST:
${castBlock(bible)}

TONE RULES:
${bible.tone_rules.map((r) => `- ${r}`).join('\n')}

${before ? `PREVIOUS SCENE ENDS: ${before.beats[before.beats.length - 1]?.action ?? ''}` : 'This is the opening scene — the hook must land in the first 3 seconds.'}

CURRENT SCENE (replace this):
${JSON.stringify(target, null, 2)}

${after ? `NEXT SCENE BEGINS: ${after.beats[0]?.action ?? ''}` : `This is the final scene — it must end on the cliffhanger: "${script.cliffhanger}"`}

Keep it within a couple of seconds of the current scene's length so the episode
still hits its target.${options.note ? `\n\nDIRECTION FROM THE WRITER: ${options.note}` : ''}`;

  return streamJson<Scene>({
    provider: options.provider,
    operation: 'script.regenerate_scene',
    system: SYSTEM,
    prompt,
    schema: sceneSchema,
    maxTokens: LLM_BUDGETS['script.regenerate_scene'],
    effort: 'low',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
  });
}
