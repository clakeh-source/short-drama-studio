import type { LlmGenerateInput, LlmProvider, LlmStreamChunk, LlmUsage } from '../types';
import { estimateScriptSeconds, WORDS_PER_SECOND } from '../../timing';
import { delay, failureFor, MALFORMED_MARKER } from './support';

/**
 * Deterministic stand-in for the language model.
 *
 * It returns fixtures that satisfy the same Zod schemas the real output must
 * satisfy, sized to the same duration budget, so the whole Phase 1 pipeline —
 * streaming, validation, persistence, usage logging — can be exercised end to
 * end in CI without an API key or a cent of spend.
 *
 * Prompts embed their structured request as `<input>{...}</input>`; the stub
 * parses that block to shape its fixture. The real adapter ignores the framing
 * and just reads the prose.
 */

/** Roughly the shape of a real streamed response: small deltas, ~25ms apart. */
const CHUNK_CHARS = 60;
const CHUNK_DELAY_MS = 25;

/** Notional pricing so cost figures are non-zero and reconcile in tests. */
const CENTS_PER_1K_IN = 0.03;
const CENTS_PER_1K_OUT = 0.15;

function parseInputBlock(input: LlmGenerateInput): Record<string, unknown> {
  const last = input.messages[input.messages.length - 1]?.content ?? '';
  const match = /<input>([\s\S]*?)<\/input>/.exec(last);
  if (!match?.[1]) return {};
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function num(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CAST = [
  {
    name: 'Mara Vance',
    role: 'protagonist',
    description: 'A hotel night manager who recognises a face she was told was dead.',
    appearance_prompt:
      'a woman in her late twenties, sharp jawline, dark hair pulled into a low knot, ' +
      'charcoal hotel blazer with a brass name pin, tired eyes, minimal makeup',
  },
  {
    name: 'Dane Ashford',
    role: 'antagonist',
    description: 'The heir who buried his own identity to escape a debt.',
    appearance_prompt:
      'a man in his early thirties, close-cropped black hair, faint scar through the ' +
      'right eyebrow, unbuttoned navy overcoat over a plain white shirt, no jewellery',
  },
  {
    name: 'Iris Calloway',
    role: 'ally',
    description: 'The concierge who has been covering for everyone for eleven years.',
    appearance_prompt:
      'a woman in her fifties, silver bob, oversized tortoiseshell glasses, burgundy ' +
      'uniform waistcoat, reading spectacles on a beaded chain',
  },
  {
    name: 'Tobin Reyes',
    role: 'wildcard',
    description: 'A valet who films everything and sells what sells.',
    appearance_prompt:
      'a young man, early twenties, buzzed hair, silver hoop earring, red valet jacket ' +
      'worn open over a black hoodie, phone always in hand',
  },
];

function bibleFixture(source: Record<string, unknown>): unknown {
  const premise = str(source, 'premise', 'A night manager recognises a dead man in the lobby.');
  const episodeCount = Math.max(1, Math.min(50, num(source, 'episodeCount', 1)));

  return {
    title: 'The Midnight Ledger',
    logline: premise.slice(0, 180),
    world:
      'A once-grand city hotel running on skeleton staff and older debts. Everything ' +
      'happens between midnight and six, when the lobby belongs to the people who ' +
      'cannot afford to be seen in daylight.',
    tone_rules: [
      'Every scene ends worse than it started.',
      'Nobody explains what the audience can infer.',
      'Money is never named directly, only implied.',
      'The camera stays at eye level; no spectacle.',
    ],
    characters: CAST.slice(0, 4),
    season_arc:
      'Mara trades silence for leverage, discovers the debt is partly hers, and has to ' +
      'choose between the man she was told was dead and the staff who covered for him.',
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      number: i + 1,
      title: `Night ${i + 1}`,
      synopsis:
        i === 0
          ? 'Mara clocks in and finds a guest who should be in a grave signing the register.'
          : `Night ${i + 1}: the cover story from night ${i} fails in front of the wrong witness.`,
    })),
  };
}

/** Lines are written to fit the duration budget when strung together. */
const BEAT_POOL = [
  { action: 'Mara freezes mid-signature.', dialogue: 'You died in March.', speaker: 'Mara Vance' },
  { action: 'Dane does not look up from the register.', dialogue: 'I got better.', speaker: 'Dane Ashford' },
  { action: 'Iris slides the key card across without being asked.', dialogue: null, speaker: null },
  { action: 'Mara blocks the lift with her shoulder.', dialogue: 'Room, or I call it in.', speaker: 'Mara Vance' },
  { action: 'Tobin lowers his phone a fraction too late.', dialogue: 'Say that again.', speaker: 'Tobin Reyes' },
  { action: 'Dane finally meets her eyes.', dialogue: 'Your name is on it too.', speaker: 'Dane Ashford' },
  { action: 'The lobby lights cut to standby.', dialogue: null, speaker: null },
  { action: 'Iris pockets the register page.', dialogue: 'Neither of you was here.', speaker: 'Iris Calloway' },
];

const LOCATIONS = [
  { location: 'Hotel lobby, front desk', time_of_day: 'night' },
  { location: 'Service corridor behind reception', time_of_day: 'night' },
  { location: 'Lift lobby, ninth floor', time_of_day: 'night' },
  { location: 'Loading bay', time_of_day: 'pre-dawn' },
];

function scriptFixture(source: Record<string, unknown>): unknown {
  const targetSeconds = num(source, 'episodeSeconds', 60);
  const sceneCount = Math.max(1, Math.min(6, Math.round(targetSeconds / 20)));

  const scenes: Array<{
    location: string;
    time_of_day: string;
    summary: string;
    beats: Array<{ action: string; dialogue: string | null; speaker: string | null }>;
  }> = Array.from({ length: sceneCount }, (_, i) => {
    const place = LOCATIONS[i % LOCATIONS.length]!;
    return {
      location: place.location,
      time_of_day: place.time_of_day,
      summary: `Beat ${i + 1} of the escalation: the lie costs more than it did a minute ago.`,
      beats: [],
    };
  });

  // Fill round-robin until the estimate reaches the target, so the fixture
  // satisfies the same ±15% duration criterion the real model is held to.
  let cursor = 0;
  while (estimateScriptSeconds(scenes) < targetSeconds * 0.95 && cursor < sceneCount * 12) {
    const scene = scenes[cursor % sceneCount]!;
    const beat = BEAT_POOL[cursor % BEAT_POOL.length]!;
    scene.beats.push({ action: beat.action, dialogue: beat.dialogue, speaker: beat.speaker });
    cursor += 1;
  }

  return {
    hook: 'A dead man signs the register in his own handwriting.',
    cliffhanger: 'Your name is on it too.',
    scenes,
  };
}

function sceneFixture(source: Record<string, unknown>): unknown {
  const index = num(source, 'sceneIndex', 0);
  const place = LOCATIONS[index % LOCATIONS.length]!;
  return {
    location: place.location,
    time_of_day: place.time_of_day,
    summary: `Regenerated scene ${index + 1}: the same corner, played colder.`,
    beats: [
      { action: 'Mara turns the register around.', dialogue: 'Read it back to me.', speaker: 'Mara Vance' },
      { action: 'Dane reads without blinking.', dialogue: 'It says I paid.', speaker: 'Dane Ashford' },
      { action: 'She takes the pen off him.', dialogue: null, speaker: null },
    ],
  };
}

/** Cycled so consecutive shots never share a framing, as the prompt demands. */
const CAMERA_CYCLE = [
  'wide',
  'close-up',
  'over-shoulder',
  'medium',
  'extreme close-up',
  'insert',
  'POV',
] as const;

function storyboardFixture(source: Record<string, unknown>): unknown {
  const scenes = Array.isArray(source.scenes) ? source.scenes : [];
  const minShots = num(source, 'minShots', 10);
  const episodeSeconds = num(source, 'episodeSeconds', 60);

  let cursor = 0;
  const built = scenes.map((raw, sceneIndex) => {
    const scene = (raw ?? {}) as Record<string, unknown>;
    const beats = Array.isArray(scene.beats) ? scene.beats : [];

    const shots = beats.map((beatRaw) => {
      const beat = (beatRaw ?? {}) as Record<string, unknown>;
      const camera = CAMERA_CYCLE[cursor % CAMERA_CYCLE.length]!;
      cursor += 1;

      const speaker = typeof beat.speaker === 'string' && beat.speaker ? beat.speaker : null;
      const dialogue = typeof beat.dialogue === 'string' && beat.dialogue ? beat.dialogue : null;

      return {
        camera,
        action: typeof beat.action === 'string' ? beat.action : 'The moment lands.',
        dialogue,
        speaker,
        // An insert holds no people; otherwise the speaker is on screen.
        characters: camera === 'insert' || !speaker ? [] : [speaker],
        duration_seconds: dialogue ? 5 : 3,
      };
    });

    return { scene_index: sceneIndex, shots };
  });

  // Top up the shortest scene until the episode has enough coverage.
  const total = () => built.reduce((n, s) => n + s.shots.length, 0);
  let guard = 0;
  while (total() < minShots && built.length > 0 && guard < 60) {
    const target = built.reduce((a, b) => (b.shots.length < a.shots.length ? b : a));
    const camera = CAMERA_CYCLE[cursor % CAMERA_CYCLE.length]!;
    cursor += 1;
    target.shots.push({
      camera,
      action: 'A held reaction before the next line.',
      dialogue: null,
      speaker: null,
      characters: [],
      duration_seconds: Math.max(3, Math.round(episodeSeconds / Math.max(1, minShots))),
    });
    guard += 1;
  }

  return { scenes: built };
}

/**
 * A breakdown of whatever script text it was handed.
 *
 * Unlike the other fixtures this one genuinely reads its input: the Phase 3
 * criteria are about *this* script producing *these* scenes, dialogue carried
 * through verbatim, and named characters mapped. A canned fixture would make all
 * three untestable without spending money on the real model.
 *
 * The parsing is deliberately crude — sluglines and screenplay-cased character
 * cues — because it only has to be good enough to prove the pipeline moves the
 * right strings to the right columns.
 */
function breakdownFixture(source: Record<string, unknown>): unknown {
  const text = str(source, 'scriptText', '');
  const maxClip = num(source, 'maxClipSeconds', 15);
  const defaultSeconds = num(source, 'defaultShotSeconds', 5);

  const lines = text.split('\n').map((l) => l.trim());

  type Shot = {
    camera: string;
    action: string;
    dialogue: string | null;
    speaker: string | null;
    characters: string[];
    duration_seconds: number;
  };
  type Scene = {
    location: string;
    time_of_day: string;
    summary: string;
    shots: Shot[];
  };

  const scenes: Scene[] = [];
  let cursor = 0;

  // Title pages and episode headers sit above the first slugline and are not
  // part of any scene. Without this the title reads as a character cue and its
  // subtitle as that character's first line.
  const hasSluglines = lines.some((l) => /^(INT\.|EXT\.|INT\/EXT\.)/i.test(l));

  const openScene = (slug: string) => {
    // "INT. HARBOUR TERMINAL - NIGHT" → location + time of day.
    const body = slug.replace(/^(INT\.|EXT\.|INT\/EXT\.)\s*/i, '');
    const [place, when] = body.split(/\s+-\s+/);
    scenes.push({
      location: titleCase(place ?? body),
      time_of_day: (when ?? 'day').toLowerCase(),
      summary: `The scene at ${titleCase(place ?? body).toLowerCase()}.`,
      shots: [],
    });
  };

  const push = (shot: Omit<Shot, 'camera'>) => {
    if (scenes.length === 0) openScene('INT. UNSPECIFIED - DAY');
    const scene = scenes[scenes.length - 1]!;
    scene.shots.push({ camera: CAMERA_CYCLE[cursor++ % CAMERA_CYCLE.length]!, ...shot });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;

    if (/^(INT\.|EXT\.|INT\/EXT\.)/i.test(line)) {
      openScene(line);
      continue;
    }

    if (hasSluglines && scenes.length === 0) continue;

    // A character cue is a short all-caps line with a line under it.
    const cue = /^([A-Z][A-Z .'-]{1,40})(\s*\(CONT'D\))?$/.exec(line);
    const next = lines[i + 1];
    if (cue && next && !/^(INT\.|EXT\.)/i.test(next)) {
      const speaker = titleCase(cue[1]!.trim());
      // A parenthetical sits between the cue and the line.
      const dialogue = /^\(.*\)$/.test(next) ? (lines[i + 2] ?? '') : next;
      const consumed = /^\(.*\)$/.test(next) ? 2 : 1;

      if (dialogue) {
        push({
          action: `${speaker} speaks.`,
          // Verbatim: the criterion is that the author's line survives the trip.
          dialogue,
          speaker,
          characters: [speaker],
          duration_seconds: Math.min(
            maxClip,
            Math.max(3, Math.ceil(dialogue.split(/\s+/).length / 2.5) + 1),
          ),
        });
        i += consumed;
        continue;
      }
    }

    // Anything else is action.
    push({
      action: line.slice(0, 600),
      dialogue: null,
      speaker: null,
      characters: namesIn(line),
      duration_seconds: defaultSeconds,
    });
  }

  if (scenes.length === 0) {
    scenes.push({
      location: 'Unspecified',
      time_of_day: 'day',
      summary: 'The whole script, uncut.',
      shots: [
        {
          camera: 'medium',
          action: text.slice(0, 600) || 'Nothing happens.',
          dialogue: null,
          speaker: null,
          characters: [],
          duration_seconds: defaultSeconds,
        },
      ],
    });
  }

  // Every scene needs at least one shot to satisfy the schema.
  for (const scene of scenes) {
    if (scene.shots.length === 0) {
      scene.shots.push({
        camera: 'wide',
        action: scene.summary,
        dialogue: null,
        speaker: null,
        characters: [],
        duration_seconds: defaultSeconds,
      });
    }
  }

  return { scenes };
}

/** Screenplay-cased names inside an action line, e.g. "MEI LIN, 32, stands". */
function namesIn(line: string): string[] {
  const found = new Set<string>();
  for (const match of line.matchAll(/\b([A-Z][A-Z]+(?: [A-Z][A-Z]+)*)\b/g)) {
    const name = match[1]!;
    // Single short words are shouting or an acronym, not a character.
    if (name.length >= 4 && !/^(INT|EXT|CONT|DELAYED)$/.test(name)) found.add(titleCase(name));
  }
  return [...found].slice(0, 6);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim();
}

function safetyFixture(source: Record<string, unknown>): unknown {
  const text = str(source, 'text', '');
  const flagged = /\[\[unsafe\]\]/i.test(text);
  return flagged
    ? { allowed: false, reasons: ['stub: refusal requested by [[unsafe]] marker'] }
    : { allowed: true, reasons: [] };
}

function fixtureFor(input: LlmGenerateInput): unknown {
  const source = parseInputBlock(input);
  switch (input.operation) {
    case 'bible.generate':
      return bibleFixture(source);
    case 'script.generate':
      return scriptFixture(source);
    case 'script.regenerate_scene':
      return sceneFixture(source);
    case 'storyboard.generate':
      return storyboardFixture(source);
    case 'breakdown.generate':
      return breakdownFixture(source);
    case 'safety.screen':
      return safetyFixture(source);
    case 'export.caption':
      return {
        caption: 'He signed his own name three months after the funeral. So who did she bury?',
        hashtags: [
          '#shortdrama',
          '#shortfilm',
          '#revenge',
          '#hotelnights',
          '#twist',
          '#whodidshebury',
        ],
        alternates: [
          'She buried him in March. He just asked for a room.',
          'The register is in his handwriting.',
        ],
      };
    default:
      return { note: `stub has no fixture for operation "${input.operation}"` };
  }
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class StubLlmProvider implements LlmProvider {
  readonly id = 'stub';
  readonly model = 'stub-model-v1';

  estimateCostCents(input: LlmGenerateInput): number {
    const promptChars =
      input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0);
    const tokensIn = Math.ceil(promptChars / 4);
    return Math.max(
      1,
      Math.ceil((tokensIn / 1000) * CENTS_PER_1K_IN + (input.maxTokens / 1000) * CENTS_PER_1K_OUT),
    );
  }

  async *stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamChunk, LlmUsage, void> {
    const promptText = input.system + input.messages.map((m) => m.content).join('\n');
    const failure = failureFor(promptText);
    if (failure) {
      await delay(200);
      throw new Error(failure.error);
    }

    // Deliberately short: Phase 1 AC #6 requires something on screen in 500ms.
    await delay(120);

    // Mimic the real shape — a little reasoning, then the answer.
    yield { type: 'thinking', text: `Planning ${input.operation}…` };
    await delay(CHUNK_DELAY_MS);

    // A successful, billed call that returns something unusable. Deliberately
    // has no `{` in it, so it fails at extraction rather than at parsing —
    // partial JSON would leave open which layer actually caught it.
    const body = promptText.includes(MALFORMED_MARKER)
      ? 'Certainly! Here is the breakdown you asked for, written out as prose ' +
        'because I have decided that reads better.'
      : JSON.stringify(fixtureFor(input), null, 2);

    for (let i = 0; i < body.length; i += CHUNK_CHARS) {
      yield { type: 'text', text: body.slice(i, i + CHUNK_CHARS) };
      await delay(CHUNK_DELAY_MS);
    }

    const tokensIn = Math.ceil(promptText.length / 4);
    const tokensOut = Math.ceil(body.length / 4);

    return {
      tokensIn,
      tokensOut,
      costCents: Math.max(
        1,
        Math.ceil((tokensIn / 1000) * CENTS_PER_1K_IN + (tokensOut / 1000) * CENTS_PER_1K_OUT),
      ),
    };
  }
}

/** Exported for the timing tests. */
export const STUB_WORDS_PER_SECOND = WORDS_PER_SECOND;
