import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { capShotDurations, generateBreakdown } from '@/lib/ai/breakdown';
import { breakdownSchema, CAMERA_VOCABULARY, type Breakdown } from '@/lib/ai/schemas';
import { mapCharacterNames } from '@/lib/data/breakdown';
import { MAX_CLIP_SECONDS, splitLongShots } from '@/lib/shots';
import { StubLlmProvider } from '@/lib/providers/stub/llm';

/**
 * Phase 3 — script breakdown, without a database.
 *
 * The parts tested here are the ones a wrong answer makes expensive later: a
 * shot longer than the provider will render is a shot that cannot be generated
 * at all, and a character name dropped on the floor is a person who silently
 * stops appearing in their own scenes.
 */

const seedScript = await readFile('scripts/seed/episode-1.txt', 'utf8');

/**
 * The seed script's dialogue, taken from the file rather than retyped.
 *
 * A hand-copied expectation here is worth nothing: it drifts from the fixture
 * the moment anyone edits the script, and a smart-quote typo makes the test fail
 * for a reason that has nothing to do with the code. Lines in a screenplay are
 * the ones directly under an all-caps character cue, and only inside a scene —
 * the title block above the first slugline looks identical and is not dialogue.
 */
const SEED_DIALOGUE = (() => {
  const lines = seedScript.split('\n').map((l) => l.trim());
  const out: string[] = [];
  let inScene = false;

  for (const [i, line] of lines.entries()) {
    if (/^(INT\.|EXT\.|INT\/EXT\.)/i.test(line)) {
      inScene = true;
      continue;
    }
    if (!inScene) continue;
    if (/^[A-Z][A-Z .'-]{1,40}(\s*\(CONT'D\))?$/.test(line) && lines[i + 1]) {
      out.push(lines[i + 1]!);
    }
  }

  return out;
})();

/* -------------------------------------------------------------------------- */
/* Character mapping                                                          */
/* -------------------------------------------------------------------------- */

const CAST = [
  { id: 'mei', name: 'Mei Lin' },
  { id: 'daniel', name: 'Daniel Voss' },
];

describe('mapCharacterNames', () => {
  it('matches a full name regardless of case', () => {
    expect(mapCharacterNames(['MEI LIN', 'daniel voss'], CAST).ids).toEqual(['mei', 'daniel']);
  });

  it('matches a first name, which is how screenplays cue people', () => {
    // The cast list says "Mei Lin"; the script says "MEI". Refusing that would
    // report most of a real cast as unmatched.
    expect(mapCharacterNames(['MEI'], CAST).ids).toEqual(['mei']);
  });

  it('refuses an ambiguous first name rather than guessing', () => {
    const twoMeis = [
      { id: 'a', name: 'Mei Lin' },
      { id: 'b', name: 'Mei Chen' },
    ];

    const result = mapCharacterNames(['Mei'], twoMeis);

    expect(result.ids).toEqual([]);
    expect(result.unmatched).toEqual(['Mei']);
  });

  it('reports an unknown name instead of dropping it', () => {
    const result = mapCharacterNames(['Mei Lin', 'Harbour Guard'], CAST);

    expect(result.ids).toEqual(['mei']);
    // The whole point: a shot that claims nobody is in it is a defect nobody
    // can see. An unmatched name is one the user can act on.
    expect(result.unmatched).toEqual(['Harbour Guard']);
  });

  it('does not list the same character twice', () => {
    expect(mapCharacterNames(['Mei Lin', 'MEI', 'Mei Lin'], CAST).ids).toEqual(['mei']);
  });

  it('ignores blank names', () => {
    const result = mapCharacterNames(['', '  ', 'Mei Lin'], CAST);
    expect(result.ids).toEqual(['mei']);
    expect(result.unmatched).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The clip ceiling                                                           */
/* -------------------------------------------------------------------------- */

describe('splitLongShots', () => {
  const identity = (shot: { seconds: number }) => shot.seconds;
  const rebuild = (shot: { seconds: number }, seconds: number) => ({ ...shot, seconds });

  it('leaves a shot at the ceiling alone', () => {
    const out = splitLongShots([{ seconds: MAX_CLIP_SECONDS }], identity, rebuild);
    expect(out).toEqual([{ seconds: MAX_CLIP_SECONDS }]);
  });

  it('splits evenly rather than leaving a stub tail', () => {
    // 22s could be 15 + 7. Even parts read as deliberate coverage; a 7-second
    // remainder reads as a mistake.
    const out = splitLongShots([{ seconds: 22 }], identity, rebuild);
    expect(out.map((s) => s.seconds)).toEqual([11, 11]);
  });

  it('preserves the total duration across a split', () => {
    for (const seconds of [16, 22, 31, 45, 60]) {
      const out = splitLongShots([{ seconds }], identity, rebuild);
      expect(out.reduce((n, s) => n + s.seconds, 0)).toBe(seconds);
      for (const part of out) expect(part.seconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    }
  });

  it('keeps unsplit shots in place around a split one', () => {
    const out = splitLongShots([{ seconds: 5 }, { seconds: 20 }, { seconds: 4 }], identity, rebuild);
    expect(out.map((s) => s.seconds)).toEqual([5, 10, 10, 4]);
  });
});

describe('capShotDurations', () => {
  const longShot: Breakdown = {
    scenes: [
      {
        location: 'Ferry deck',
        time_of_day: 'night',
        summary: 'A long unbroken exchange.',
        shots: [
          {
            camera: 'medium',
            action: 'Daniel watches the terminal recede.',
            dialogue: 'You should have stayed on the dock.',
            speaker: 'Daniel Voss',
            characters: ['Daniel Voss'],
            // Past what the schema allows, on purpose: the splitter has to be
            // correct in its own right, not merely unreachable behind the schema.
            duration_seconds: 24,
          },
        ],
      },
    ],
  };

  it('splits a shot the provider could never render', () => {
    const shots = capShotDurations(longShot).scenes[0]!.shots;

    expect(shots).toHaveLength(2);
    for (const shot of shots) {
      expect(shot.duration_seconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    }
  });

  it('gives the line to the first part only', () => {
    const shots = capShotDurations(longShot).scenes[0]!.shots;

    // Copying the dialogue onto every part would have the line spoken two or
    // three times over once TTS runs.
    expect(shots[0]!.dialogue).toBe('You should have stayed on the dock.');
    expect(shots[0]!.speaker).toBe('Daniel Voss');
    expect(shots[1]!.dialogue).toBeNull();
    expect(shots[1]!.speaker).toBeNull();
  });

  it('labels the parts so the board reads as one beat', () => {
    const shots = capShotDurations(longShot).scenes[0]!.shots;
    expect(shots[0]!.action).toMatch(/part 1 of 2/);
    expect(shots[1]!.action).toMatch(/part 2 of 2/);
  });

  it('leaves a compliant breakdown untouched', () => {
    const fine: Breakdown = {
      scenes: [
        {
          location: 'Terminal',
          time_of_day: 'night',
          summary: 'Mei waits.',
          shots: [
            {
              camera: 'wide',
              action: 'Rain on the glass.',
              dialogue: null,
              speaker: null,
              characters: [],
              duration_seconds: 5,
            },
          ],
        },
      ],
    };

    expect(capShotDurations(fine)).toEqual(fine);
  });
});

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

describe('generateBreakdown', () => {
  it('produces a breakdown of the seed script that satisfies the schema', async () => {
    const result = await generateBreakdown({
      provider: new StubLlmProvider(),
      scriptText: seedScript,
      castNames: ['Mei Lin', 'Daniel Voss'],
      seriesTitle: 'The Last Ferry',
    });

    expect(breakdownSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.scenes.length).toBeGreaterThanOrEqual(2);
  });

  it('finds both sluglines as separate scenes', async () => {
    const result = await generateBreakdown({
      provider: new StubLlmProvider(),
      scriptText: seedScript,
      castNames: [],
    });

    const locations = result.data.scenes.map((s) => s.location.toLowerCase());
    expect(locations.some((l) => l.includes('harbour terminal'))).toBe(true);
    expect(locations.some((l) => l.includes('ferry deck'))).toBe(true);
  });

  it('carries the script’s dialogue through verbatim', async () => {
    const result = await generateBreakdown({
      provider: new StubLlmProvider(),
      scriptText: seedScript,
      castNames: ['Mei Lin', 'Daniel Voss'],
    });

    const lines = result.data.scenes.flatMap((s) =>
      s.shots.map((shot) => shot.dialogue).filter(Boolean),
    );

    // The dialogue is the author's writing and is what TTS speaks aloud. A
    // paraphrase here is a silent edit of someone's script.
    expect(SEED_DIALOGUE.length).toBeGreaterThanOrEqual(4);
    for (const line of SEED_DIALOGUE) {
      expect(lines, `"${line}" did not survive the breakdown`).toContain(line);
    }
  });

  it('uses only the camera vocabulary, and never repeats a framing back to back', async () => {
    const result = await generateBreakdown({
      provider: new StubLlmProvider(),
      scriptText: seedScript,
      castNames: [],
    });

    for (const scene of result.data.scenes) {
      let previous: string | null = null;
      for (const shot of scene.shots) {
        expect(CAMERA_VOCABULARY).toContain(shot.camera);
        expect(shot.camera).not.toBe(previous);
        previous = shot.camera;
      }
    }
  });

  it('never returns a shot the provider could not render', async () => {
    const result = await generateBreakdown({
      provider: new StubLlmProvider(),
      scriptText: seedScript,
      castNames: [],
    });

    for (const scene of result.data.scenes) {
      for (const shot of scene.shots) {
        expect(shot.duration_seconds).toBeGreaterThan(0);
        expect(shot.duration_seconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
      }
    }
  });
});
