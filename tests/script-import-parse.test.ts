import { describe, expect, it } from 'vitest';
import { MAX_SCENES_PER_EPISODE, parseScriptText } from '@/lib/script-import/parse';
import { scriptSchema } from '@/lib/ai/schemas';

/**
 * The importer's contract is that its output is indistinguishable from a
 * generated script — so almost every test here ends by validating against
 * `scriptSchema`, the same arbiter the model's output has to satisfy. A parser
 * that produced a nicer shape than the pipeline accepts would be useless.
 */

const SCREENPLAY = `
EPISODE 1 — The Wrong Name

INT. SHREDDING CORRIDOR - 11 PM

Nadia lifts a document off the cart and reads it.

NADIA
My name is on this.

Priya rounds the corner, fast.

PRIYA (CONT'D)
    (sharply)
    Put it back.

CUT TO:

EXT. LOADING BAY - CONTINUOUS

Marcus waits by the van.

EPISODE 2: Initialled

INT. COPY ROOM - NIGHT

The door clicks shut.

PRIYA
That document is not yours.
Give it to me.
`;

const PROSE = `
Nadia: I didn't read it.
Priya: You're lying.

She steps back and turns the page.

Nadia: Look at the date.
`;

describe('parseScriptText — screenplay format', () => {
  const result = parseScriptText(SCREENPLAY);

  it('splits on episode markers and keeps their titles', () => {
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0]!.number).toBe(1);
    expect(result.episodes[0]!.title).toBe('The Wrong Name');
    expect(result.episodes[1]!.number).toBe(2);
    expect(result.episodes[1]!.title).toBe('Initialled');
  });

  it('splits on sluglines and reads location and time of day', () => {
    const [first, second] = result.episodes[0]!.script.scenes;
    expect(result.episodes[0]!.script.scenes).toHaveLength(2);
    expect(first!.location).toBe('SHREDDING CORRIDOR');
    expect(first!.time_of_day).toBe('11 PM');
    expect(second!.location).toBe('LOADING BAY');
    expect(second!.time_of_day).toBe('CONTINUOUS');
  });

  it('attributes dialogue to the speaker cue above it', () => {
    const beats = result.episodes[0]!.script.scenes[0]!.beats;
    const spoken = beats.filter((b) => b.dialogue);
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatchObject({ speaker: 'NADIA', dialogue: 'My name is on this.' });
    expect(spoken[1]!.speaker).toBe('PRIYA');
  });

  it('folds the action before a line into the same beat as the line', () => {
    const beats = result.episodes[0]!.script.scenes[0]!.beats;
    const priya = beats.find((b) => b.speaker === 'PRIYA')!;
    expect(priya.action).toBe('Priya rounds the corner, fast.');
  });

  it('drops (CONT\'D), parentheticals and transitions', () => {
    const scenes = result.episodes[0]!.script.scenes;
    const all = JSON.stringify(scenes);
    expect(all).not.toMatch(/CONT'D/);
    expect(all).not.toMatch(/sharply/);
    expect(all).not.toMatch(/CUT TO/);
  });

  it('joins a multi-line speech into one piece of dialogue', () => {
    const priya = result.episodes[1]!.script.scenes[0]!.beats.find((b) => b.dialogue)!;
    expect(priya.dialogue).toBe('That document is not yours. Give it to me.');
  });

  it('collects every speaker for cast derivation', () => {
    expect(result.speakers).toEqual(['NADIA', 'PRIYA']);
  });

  it('produces scripts the pipeline accepts unmodified', () => {
    for (const episode of result.episodes) {
      expect(scriptSchema.safeParse(episode.script).success).toBe(true);
    }
  });

  it('leaves clean scenes unflagged', () => {
    expect(result.episodes[0]!.script.scenes[0]!.parse_warnings).toBeUndefined();
  });
});

describe('parseScriptText — prose with inline speakers', () => {
  const result = parseScriptText(PROSE);

  it('reads "Name: line" attribution', () => {
    const beats = result.episodes[0]!.script.scenes.flatMap((s) => s.beats);
    expect(beats.find((b) => b.dialogue)).toMatchObject({
      speaker: 'Nadia',
      dialogue: "I didn't read it.",
    });
  });

  it('flags every inferred scene break rather than presenting it as certain', () => {
    for (const scene of result.episodes[0]!.script.scenes) {
      expect(scene.parse_warnings?.map((w) => w.code)).toContain('inferred_scene_break');
    }
  });

  it('still validates', () => {
    expect(scriptSchema.safeParse(result.episodes[0]!.script).success).toBe(true);
  });
});

describe('parseScriptText — ambiguity is surfaced, not resolved', () => {
  it('warns when a heading has no time of day', () => {
    const result = parseScriptText('INT. KITCHEN\n\nShe waits.');
    expect(result.episodes[0]!.script.scenes[0]!.parse_warnings?.map((w) => w.code)).toContain(
      'missing_slugline',
    );
    // Assumed, but declared — not silently correct-looking.
    expect(result.episodes[0]!.script.scenes[0]!.time_of_day).toBe('DAY');
  });

  it('warns when an episode has no dialogue at all', () => {
    const result = parseScriptText('INT. KITCHEN - DAY\n\nShe waits. Nothing happens.');
    expect(result.episodes[0]!.warnings.map((w) => w.code)).toContain('no_speakers_found');
  });

  it('splits an unmarked over-long script into episodes and says so', () => {
    const long = Array.from(
      { length: MAX_SCENES_PER_EPISODE + 3 },
      (_, i) => `INT. ROOM ${i} - DAY\n\nSomething happens in room ${i}.\n`,
    ).join('\n');

    const result = parseScriptText(long);

    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0]!.script.scenes).toHaveLength(MAX_SCENES_PER_EPISODE);
    expect(result.episodes[1]!.script.scenes).toHaveLength(3);
    expect(result.warnings.map((w) => w.code)).toContain('auto_split_episodes');
    // Nothing is dropped on the floor.
    for (const episode of result.episodes) {
      expect(scriptSchema.safeParse(episode.script).success).toBe(true);
    }
  });

  it('flags rather than overrides when the user marked the episodes themselves', () => {
    const scenes = Array.from(
      { length: MAX_SCENES_PER_EPISODE + 2 },
      (_, i) => `INT. ROOM ${i} - DAY\n\nSomething happens.\n`,
    ).join('\n');

    const result = parseScriptText(`EPISODE 1\n${scenes}`);

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]!.warnings.map((w) => w.code)).toContain('too_many_scenes');
  });

  it('never throws on junk, and says nothing was readable', () => {
    const result = parseScriptText('   \n\n  \n');
    expect(result.episodes).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unparsed_tail');
  });
});

/**
 * Word puts a blank line after every paragraph, and `mammoth` reproduces it. A
 * blank line ends a speech here, so untreated this loses every speaker in every
 * .docx anyone uploads.
 */
describe('parseScriptText — double-spaced documents', () => {
  const DOUBLE_SPACED = [
    'INT. KITCHEN - NIGHT',
    '',
    'She reads the letter twice.',
    '',
    'NADIA',
    '',
    'This is my name.',
    '',
    'DAD',
    '',
    'Put it down.',
    '',
  ].join('\n');

  it('still attributes dialogue when a cue is a blank line from its own words', () => {
    const result = parseScriptText(DOUBLE_SPACED);
    const beats = result.episodes[0]!.script.scenes.flatMap((s) => s.beats);

    expect(result.speakers).toEqual(['NADIA', 'DAD']);
    expect(beats.find((b) => b.speaker === 'NADIA')?.dialogue).toBe('This is my name.');
    expect(beats.find((b) => b.speaker === 'DAD')?.dialogue).toBe('Put it down.');
  });

  it('does not shatter a slugline-less double-spaced script into one scene per paragraph', () => {
    const prose = ['Nadia waits.', '', 'Priya arrives.', '', 'They both look up.', ''].join('\n');
    expect(parseScriptText(prose).episodes[0]!.script.scenes).toHaveLength(1);
  });

  it('leaves a normally-spaced script untouched', () => {
    const result = parseScriptText(SCREENPLAY);
    // The same assertions as the screenplay suite: collapsing must be inert here.
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0]!.script.scenes).toHaveLength(2);
    expect(result.speakers).toEqual(['NADIA', 'PRIYA']);
  });
});

describe('parseScriptText — clamps to the schema it must satisfy', () => {
  it('truncates over-long fields instead of emitting invalid output', () => {
    const result = parseScriptText(`INT. ${'A'.repeat(400)} - DAY\n\n${'word '.repeat(400)}`);
    const scene = result.episodes[0]!.script.scenes[0]!;

    expect(scene.location.length).toBeLessThanOrEqual(160);
    expect(scene.beats[0]!.action.length).toBeLessThanOrEqual(600);
    expect(scriptSchema.safeParse(result.episodes[0]!.script).success).toBe(true);
  });

  it('keeps its scene ceiling in step with the schema', () => {
    const overflow = {
      hook: 'h',
      cliffhanger: 'c',
      scenes: Array.from({ length: MAX_SCENES_PER_EPISODE + 1 }, () => ({
        location: 'L',
        time_of_day: 'DAY',
        summary: 'S',
        beats: [{ action: 'A' }],
      })),
    };
    expect(scriptSchema.safeParse(overflow).success).toBe(false);
  });
});
