import 'server-only';

import type { LlmProvider, LlmStreamChunk } from '@/lib/providers';
import { MAX_CLIP_SECONDS, splitLongShots } from '@/lib/shots';
import { streamJson } from './json';
import { breakdownSchema, type Breakdown, type BreakdownShot } from './schemas';
import { CAMERA_VOCABULARY } from './prompts';
import { inputBlock, JSON_RULES, SAFETY_RULES } from './prompts/rules';

/**
 * Raw screenplay → scenes and shots, in one model pass.
 *
 * The input here is a script the user wrote, not one this app generated, so the
 * job is transcription and interpretation at once: find the scene boundaries,
 * decide the coverage, and carry the writing through intact. Two things are
 * therefore not the model's to decide — the dialogue, which is the user's and is
 * copied verbatim, and the final durations, which are capped and split
 * deterministically afterwards.
 */

/** Default when a shot's length is not implied by anything in the script. */
export const DEFAULT_SHOT_SECONDS = 5;

const SYSTEM = `You are a first assistant director breaking a vertical short-drama
script into a shot list. The script is the author's; your job is to read it
faithfully, not to improve it.

CAMERA VOCABULARY — use these exact strings and nothing else:
${CAMERA_VOCABULARY.map((c) => `- ${c}`).join('\n')}

SCENES:
- A new scene starts at a slugline (INT./EXT.), or at any clear change of place
  or time. Infer the break when the script does not mark one.
- \`location\` is a short physical place — "Harbour terminal, ticket window".
  \`time_of_day\` is one or two words — "night", "pre-dawn".
- \`summary\` is one sentence on what changes in the scene.

INFERRING THE SHOT TYPE:
Read the action and pick the framing it describes. Do not default to "medium".
- Someone notices, decides, or reacts → close-up or extreme close-up.
- A named object doing work — a screen, a key, a signature → insert.
- Two people talking, facing each other → over-shoulder, alternating.
- Arriving, leaving, or establishing a place → wide.
- What a character sees, when the script says so → POV. They are not in it.
- Never use the same framing for two consecutive shots.

DIALOGUE — copy it, do not write it:
- \`dialogue\` is the character's line exactly as written, word for word,
  punctuation included. Never paraphrase, shorten, tidy or translate it. It is
  spoken aloud from this field; an edit here silently rewrites the author.
- Strip only the surrounding screenplay furniture: the character cue above the
  line, parentheticals, and "(CONT'D)".
- \`speaker\` is the name from the character cue. A shot with no line has
  \`dialogue: null\` and \`speaker: null\`.

WHO IS IN FRAME:
List only characters actually visible in that shot, using the exact name the
script uses. Include people who are present but silent. An insert has none. Do
not invent names, and do not omit a name because it is not in the cast list —
names that do not match are handled downstream.

DURATION:
- ${DEFAULT_SHOT_SECONDS} seconds is the default. Dialogue plays at about 2.5 words per second,
  so give a line its length plus a second of air. Silent reactions are 3 seconds.
- ${MAX_CLIP_SECONDS} seconds is a hard ceiling — one shot is one generated clip, and no clip
  can be longer than that. A beat that needs more time becomes two or more
  consecutive shots with different framings, not one long one.

${SAFETY_RULES}

${JSON_RULES}

Schema:
{
  "scenes": [
    {
      "location": string,
      "time_of_day": string,
      "summary": string,
      "shots": [
        {
          "camera": string,           // exactly one of the vocabulary above
          "action": string,           // what is visible
          "dialogue": string | null,  // verbatim from the script
          "speaker": string | null,   // the character cue, or null
          "characters": string[],     // names visible in frame
          "duration_seconds": number  // 1-${MAX_CLIP_SECONDS}
        }
      ]
    }
  ]
}`;

export interface GenerateBreakdownOptions {
  provider: LlmProvider;
  /** The screenplay as written. */
  scriptText: string;
  /** Names the breakdown should prefer when the script is ambiguous. */
  castNames: readonly string[];
  /** Series style, when there is a bible. Purely advisory to the model. */
  seriesTitle?: string;
  onDelta?: (chunk: LlmStreamChunk) => void;
  /** Test seam; see StreamJsonOptions. */
  retryDelayMs?: number;
}

export async function generateBreakdown(options: GenerateBreakdownOptions) {
  const prompt = `Break this script into scenes and shots.

${inputBlock({
  seriesTitle: options.seriesTitle ?? null,
  castNames: [...options.castNames],
  maxClipSeconds: MAX_CLIP_SECONDS,
  defaultShotSeconds: DEFAULT_SHOT_SECONDS,
  scriptText: options.scriptText,
})}

CAST ALREADY IN THIS SERIES — prefer these spellings when the script means one
of them:
${
  options.castNames.length > 0
    ? options.castNames.map((n) => `- ${n}`).join('\n')
    : '- (none yet)'
}

Cover the whole script, in order. Every line of dialogue in it must appear
verbatim in exactly one shot.

SCRIPT:
${options.scriptText}`;

  const result = await streamJson<Breakdown>({
    provider: options.provider,
    operation: 'breakdown.generate',
    system: SYSTEM,
    prompt,
    schema: breakdownSchema,
    maxTokens: 32_000,
    effort: 'low',
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  });

  return { ...result, data: capShotDurations(result.data) };
}

/**
 * Applies the clip ceiling to a validated breakdown.
 *
 * The schema already refuses anything over the cap, and the prompt asks for the
 * split — this is the third layer, and the only one that is unconditional. It
 * exists because the cost of getting this wrong is not a worse shot, it is a
 * shot that cannot be generated at all.
 *
 * Exported for the tests, which feed it durations the schema would have caught,
 * to prove the splitter itself is correct rather than merely unreachable.
 */
export function capShotDurations(breakdown: Breakdown): Breakdown {
  return {
    scenes: breakdown.scenes.map((scene) => ({
      ...scene,
      shots: splitLongShots<BreakdownShot>(
        scene.shots,
        (shot) => shot.duration_seconds,
        (shot, seconds, part, parts) => ({
          ...shot,
          duration_seconds: seconds,
          // Only the first part keeps the line: repeating the dialogue across
          // every part would have TTS speak it two or three times over.
          dialogue: part === 0 ? (shot.dialogue ?? null) : null,
          speaker: part === 0 ? (shot.speaker ?? null) : null,
          action: parts > 1 ? `${shot.action} (part ${part + 1} of ${parts})` : shot.action,
        }),
      ),
    })),
  };
}
