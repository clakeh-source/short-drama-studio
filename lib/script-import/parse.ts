import type { Beat, ParseWarning, Scene, Script } from '@/lib/ai/schemas';

/**
 * Turns a script somebody wrote elsewhere into the same shape the model emits.
 *
 * Pure and synchronous — no database, no model, no `server-only` — because the
 * whole value of this module is that its behaviour on a messy real script can be
 * asserted directly. Everything it cannot work out for certain becomes a
 * `ParseWarning` on the scene it affects; nothing is quietly invented. The
 * confirm screen is what resolves those, which is why this never writes.
 *
 * It recognises ordinary screenplay convention (sluglines, ALL-CAPS speaker
 * cues) and degrades to prose with "NAME: line" dialogue, which is what people
 * actually paste.
 */

/* -------------------------------------------------------------------------- */
/* Schema-imposed ceilings                                                    */
/*                                                                            */
/* These mirror `scriptSchema`. They are duplicated rather than derived because */
/* Zod does not expose a max, and a test asserts the two stay in step.         */
/* -------------------------------------------------------------------------- */

export const MAX_SCENES_PER_EPISODE = 12;
const MAX_BEATS_PER_SCENE = 40;
const MAX_ACTION = 600;
const MAX_DIALOGUE = 400;
const MAX_SPEAKER = 80;
const MAX_LOCATION = 160;
const MAX_TIME_OF_DAY = 60;
const MAX_SUMMARY = 600;
const MAX_HOOK = 500;

/* -------------------------------------------------------------------------- */
/* Line classification                                                        */
/* -------------------------------------------------------------------------- */

/** "EPISODE 2", "EP 2:", "## Episode 2 — The Wrong Name". */
const EPISODE_RE = /^[\s#*_>-]*(?:EPISODE|EP)\b[\s.:#—–-]*(\d+)\s*[.:—–-]*\s*(.*)$/i;

/** "INT. KITCHEN - NIGHT", "EXT./INT. CAR — DAY". */
const SLUGLINE_RE = /^[\s#*_>-]*(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E|INT\.?|EXT\.?)\s+(.+)$/i;

/** Camera instructions carry no story; they are dropped, not turned into beats. */
const TRANSITION_RE =
  /^\s*(?:CUT TO:?|FADE (?:IN|OUT)\.?:?|FADE TO BLACK\.?|DISSOLVE TO:?|SMASH CUT(?: TO)?:?|MATCH CUT(?: TO)?:?|THE END\.?)\s*$/i;

/** "(beat)", "(CONT'D)" — direction attached to a line, not a line of its own. */
const PARENTHETICAL_RE = /^\s*\(.*\)\s*$/;

/** A centred ALL-CAPS name introducing dialogue: "NADIA", "NADIA (CONT'D)". */
const SPEAKER_CUE_RE =
  /^\s*([A-Z][A-Z0-9 .'’-]{0,60}?)\s*(?:\((?:CONT'D|CONTD|V\.?O\.?|O\.?S\.?|O\.?C\.?|PRE-?LAP)\)\s*)?$/;

/** Prose-style attribution: "Nadia: I didn't read it." */
const INLINE_SPEAKER_RE = /^\s*([\p{L}][\p{L}\d .'’-]{0,60}?)\s*:\s*(\S.*)$/u;

/** A horizontal rule people use to separate scenes: "---", "***", "===". */
const RULE_RE = /^\s*([-*=_])\1{2,}\s*$/;

function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function isSpeakerCue(line: string): boolean {
  if (!SPEAKER_CUE_RE.test(line)) return false;
  const bare = line.replace(/\(.*\)/, '').trim();
  // Needs a letter, and a trailing full stop means it is a sentence in caps —
  // an action line somebody shouted — not a name.
  return /[A-Z]/.test(bare) && !bare.endsWith('.') && bare.length >= 2;
}

/** "KITCHEN - NIGHT" → location + time of day, on the last separator. */
function splitSlugline(rest: string): { location: string; timeOfDay: string | null } {
  const match = /^(.*?)\s+[-–—]{1,2}\s+([^-–—]+)$/.exec(rest.trim());
  if (!match) return { location: rest.trim(), timeOfDay: null };
  return { location: match[1]!.trim(), timeOfDay: match[2]!.trim() };
}

/* -------------------------------------------------------------------------- */
/* Beats                                                                      */
/* -------------------------------------------------------------------------- */

interface RawBeat {
  action: string | null;
  dialogue: string | null;
  speaker: string | null;
}

/**
 * Reads one scene's body into beats.
 *
 * An action line immediately before dialogue belongs *to* that dialogue — it is
 * what the character is doing while they speak — so it is folded in rather than
 * emitted as a beat of its own. That is what makes an imported scene shot-list
 * the same way a generated one does.
 */
function readBeats(lines: string[]): { beats: RawBeat[]; warnings: ParseWarning[] } {
  const beats: RawBeat[] = [];
  const warnings: ParseWarning[] = [];
  let pendingAction: string | null = null;
  /**
   * Screenplay format *always* separates an action block from the character cue
   * below it with a blank line, so a blank cannot mean "this action stands
   * alone" — it only marks the end of the block. What follows decides: another
   * action block flushes the pending one, a cue folds it into that beat.
   */
  let blankSinceAction = false;

  const flushAction = () => {
    if (pendingAction) {
      beats.push({ action: pendingAction, dialogue: null, speaker: null });
      pendingAction = null;
    }
    blankSinceAction = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      blankSinceAction = true;
      continue;
    }

    // A transition ends the moment outright; nothing can fold across it.
    if (TRANSITION_RE.test(trimmed) || RULE_RE.test(trimmed)) {
      flushAction();
      continue;
    }

    // "Nadia: I didn't read it." — one line, speaker and dialogue together.
    const inline = INLINE_SPEAKER_RE.exec(trimmed);
    if (inline && !SLUGLINE_RE.test(trimmed)) {
      const speaker = inline[1]!.trim();
      const dialogue = inline[2]!.trim();
      beats.push({
        action: pendingAction,
        dialogue,
        speaker,
      });
      pendingAction = null;
      blankSinceAction = false;
      continue;
    }

    // A speaker cue owns every following line until the next blank.
    if (isSpeakerCue(trimmed)) {
      const spoken: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (!next) break;
        if (PARENTHETICAL_RE.test(next)) continue; // "(quietly)" is direction
        if (isSpeakerCue(next) || SLUGLINE_RE.test(next)) break;
        spoken.push(next);
      }

      if (spoken.length > 0) {
        beats.push({
          action: pendingAction,
          dialogue: spoken.join(' '),
          speaker: trimmed.replace(/\(.*\)/, '').trim(),
        });
        pendingAction = null;
        blankSinceAction = false;
        i = j - 1;
        continue;
      }
      // A name with nothing under it is just an action line in caps.
    }

    if (PARENTHETICAL_RE.test(trimmed)) continue;

    // Plain action. Lines in one block join into a beat; a new block after a
    // blank line is a new beat, since nothing spoken claimed the previous one.
    if (pendingAction && blankSinceAction) flushAction();
    pendingAction = pendingAction ? `${pendingAction} ${trimmed}` : trimmed;
    blankSinceAction = false;
  }

  flushAction();
  return { beats, warnings };
}

/* -------------------------------------------------------------------------- */
/* Scenes                                                                     */
/* -------------------------------------------------------------------------- */

interface RawScene {
  location: string | null;
  timeOfDay: string | null;
  lines: string[];
  /** True when the break was inferred rather than marked by a slugline. */
  inferred: boolean;
}

/** Splits an episode's lines on sluglines. */
function splitOnSluglines(lines: string[]): RawScene[] {
  const scenes: RawScene[] = [];
  let current: RawScene | null = null;

  for (const line of lines) {
    const slug = SLUGLINE_RE.exec(line.trim());
    if (slug) {
      const { location, timeOfDay } = splitSlugline(slug[2]!);
      current = { location, timeOfDay, lines: [], inferred: false };
      scenes.push(current);
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      // Text before the first slugline — a title page, a note. Keep it in a
      // scene so nothing is dropped; the caller warns about it.
      current = { location: null, timeOfDay: null, lines: [], inferred: true };
      scenes.push(current);
    }
    current.lines.push(line);
  }

  return scenes;
}

/**
 * No sluglines anywhere: fall back to structure. A horizontal rule is an
 * explicit break; otherwise a blank-line gap is the only signal there is.
 */
function splitWithoutSluglines(lines: string[]): RawScene[] {
  const blocks: string[][] = [];
  let block: string[] = [];
  let blankRun = 0;

  for (const line of lines) {
    if (RULE_RE.test(line.trim())) {
      if (block.length) blocks.push(block);
      block = [];
      blankRun = 0;
      continue;
    }
    if (!line.trim()) {
      blankRun += 1;
      // Two or more blank lines reads as a section break; one is a paragraph.
      if (blankRun >= 2 && block.length) {
        blocks.push(block);
        block = [];
      }
      continue;
    }
    blankRun = 0;
    block.push(line);
  }
  if (block.length) blocks.push(block);

  return blocks.map((b) => ({ location: null, timeOfDay: null, lines: b, inferred: true }));
}

function summarise(beats: RawBeat[]): string {
  const first = beats.find((b) => b.action) ?? beats[0];
  if (first?.action) return clamp(first.action, MAX_SUMMARY);
  if (first?.dialogue) return clamp(`${first.speaker ?? 'Someone'}: ${first.dialogue}`, MAX_SUMMARY);
  return 'Imported scene.';
}

function toScene(raw: RawScene, index: number): { scene: Scene; warnings: ParseWarning[] } {
  const { beats } = readBeats(raw.lines);
  const warnings: ParseWarning[] = [];

  if (raw.inferred) {
    warnings.push({
      code: 'inferred_scene_break',
      message:
        'No INT./EXT. heading — this scene break was inferred from the layout. Confirm it is in the right place.',
    });
  } else if (!raw.timeOfDay) {
    warnings.push({
      code: 'missing_slugline',
      message: 'The heading gives a location but no time of day; "DAY" was assumed.',
    });
  }

  const usable = beats.length > 0 ? beats : [{ action: 'Imported scene.', dialogue: null, speaker: null }];

  if (usable.some((b) => b.dialogue && !b.speaker)) {
    warnings.push({
      code: 'unattributed_dialogue',
      message: 'Some dialogue here has no identifiable speaker. Assign one before generating.',
    });
  }

  const finalBeats: Beat[] = usable.slice(0, MAX_BEATS_PER_SCENE).map((b) => ({
    // The schema requires an action, and a line of dialogue with no staging is
    // still a filmable moment — say plainly that the character speaks.
    action: clamp(b.action ?? `${b.speaker ?? 'A character'} speaks.`, MAX_ACTION),
    dialogue: b.dialogue ? clamp(b.dialogue, MAX_DIALOGUE) : null,
    speaker: b.speaker ? clamp(b.speaker, MAX_SPEAKER) : null,
  }));

  if (usable.length > MAX_BEATS_PER_SCENE) {
    warnings.push({
      code: 'unparsed_tail',
      message: `This scene had ${usable.length} beats; only the first ${MAX_BEATS_PER_SCENE} were kept.`,
    });
  }

  return {
    scene: {
      location: clamp(raw.location ?? `Scene ${index + 1}`, MAX_LOCATION),
      time_of_day: clamp(raw.timeOfDay ?? 'DAY', MAX_TIME_OF_DAY),
      summary: summarise(usable),
      beats: finalBeats,
      ...(warnings.length ? { parse_warnings: warnings } : {}),
    },
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Episodes                                                                   */
/* -------------------------------------------------------------------------- */

export interface ParsedEpisode {
  number: number;
  title: string;
  script: Script;
  /** Everything flagged inside this episode, for a single badge in the UI. */
  warnings: ParseWarning[];
}

export interface ParseResult {
  episodes: ParsedEpisode[];
  /** Document-level notes: how it was split, what was ignored. */
  warnings: ParseWarning[];
  /** Every distinct speaker found, in first-appearance order. */
  speakers: string[];
}

/**
 * Undoes uniform double-spacing before anything else looks at the text.
 *
 * Word documents — and `mammoth`, which reads them — put a blank line after
 * every paragraph. Blank lines are load-bearing here: they end a speech and, in
 * a script with no sluglines, mark a scene break. Left alone, a double-spaced
 * document has a character cue separated from their own line, so every speaker
 * is lost and every paragraph becomes its own scene.
 *
 * Only applied when the spacing is genuinely uniform, so a normal script that
 * happens to contain blank lines keeps them exactly as written. Runs are
 * shortened by one rather than removed, so a deliberate double break survives
 * as a single one and still reads as a section break.
 */
function collapseUniformSpacing(lines: string[]): string[] {
  const nonBlank = lines.filter((l) => l.trim()).length;
  if (nonBlank < 3) return lines;

  let followedByBlank = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]!.trim() && !lines[i + 1]!.trim()) followedByBlank += 1;
  }

  // Nearly every line spaced from the next: that is formatting, not structure.
  if (followedByBlank / nonBlank < 0.8) return lines;

  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.trim()) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && !lines[end]!.trim()) end += 1;
    for (let k = 0; k < end - i - 1; k++) out.push('');
    i = end;
  }
  return out;
}

interface EpisodeBlock {
  number: number;
  title: string;
  lines: string[];
  explicit: boolean;
}

function splitEpisodes(lines: string[]): EpisodeBlock[] {
  const blocks: EpisodeBlock[] = [];
  let current: EpisodeBlock | null = null;

  for (const line of lines) {
    const match = EPISODE_RE.exec(line);
    if (match) {
      const number = Number.parseInt(match[1]!, 10);
      current = {
        number,
        title: (match[2] ?? '').trim().replace(/^[.:—–-]+\s*/, ''),
        lines: [],
        explicit: true,
      };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { number: 1, title: '', lines: [], explicit: false };
      blocks.push(current);
    }
    current.lines.push(line);
  }

  return blocks;
}

function buildScript(scenes: Scene[]): Script {
  const allBeats = scenes.flatMap((s) => s.beats);
  const first = allBeats[0];
  const last = allBeats[allBeats.length - 1];

  return {
    // The opening and closing moments, taken as written. The user can rewrite
    // both in the editor; inventing them would be putting words in their mouth.
    hook: clamp(first?.dialogue ?? first?.action ?? 'Imported script.', MAX_HOOK),
    cliffhanger: clamp(last?.dialogue ?? last?.action ?? 'End of episode.', MAX_HOOK),
    scenes,
  };
}

/**
 * Parses a whole pasted or uploaded script.
 *
 * Never throws on malformed input: anything it cannot read becomes a warning on
 * a scene the user can then fix, because a parse failure at this stage would
 * throw away work they have already done elsewhere.
 */
export function parseScriptText(raw: string): ParseResult {
  const lines = collapseUniformSpacing(raw.replace(/\r\n?/g, '\n').split('\n'));
  const warnings: ParseWarning[] = [];

  const blocks = splitEpisodes(lines).filter((b) => b.lines.some((l) => l.trim()));
  const explicitEpisodes = blocks.some((b) => b.explicit);

  const episodes: ParsedEpisode[] = [];

  for (const block of blocks) {
    const withSluglines = splitOnSluglines(block.lines);
    const hasSluglines = withSluglines.some((s) => !s.inferred);
    const rawScenes = (hasSluglines ? withSluglines : splitWithoutSluglines(block.lines)).filter(
      (s) => s.lines.some((l) => l.trim()),
    );

    const built = rawScenes.map((s, i) => toScene(s, i));
    const scenes = built.map((b) => b.scene);

    /**
     * More scenes than one episode can hold.
     *
     * When the user marked episodes themselves, their structure is the answer
     * and overriding it would be wrong — so it is flagged for them to fix. When
     * nothing marked the episodes, the split is ours to make: continue into
     * further episodes and say so, rather than dropping the tail.
     */
    const chunks: Scene[][] = [];
    if (scenes.length > MAX_SCENES_PER_EPISODE && !explicitEpisodes) {
      for (let i = 0; i < scenes.length; i += MAX_SCENES_PER_EPISODE) {
        chunks.push(scenes.slice(i, i + MAX_SCENES_PER_EPISODE));
      }
      warnings.push({
        code: 'auto_split_episodes',
        message:
          `No episode markers found and the script has ${scenes.length} scenes, so it was split ` +
          `into ${chunks.length} episodes of up to ${MAX_SCENES_PER_EPISODE}. Confirm the breaks.`,
      });
    } else {
      chunks.push(scenes);
    }

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const number = explicitEpisodes ? block.number : episodes.length + 1;
      const episodeWarnings = chunk.flatMap((s) => s.parse_warnings ?? []);

      if (chunk.length > MAX_SCENES_PER_EPISODE) {
        episodeWarnings.push({
          code: 'too_many_scenes',
          message:
            `Episode ${number} has ${chunk.length} scenes; the pipeline supports ` +
            `${MAX_SCENES_PER_EPISODE}. Merge or remove scenes before continuing.`,
        });
      }

      if (!chunk.some((s) => s.beats.some((b) => b.speaker))) {
        episodeWarnings.push({
          code: 'no_speakers_found',
          message:
            'No speaker labels were found in this episode, so every beat is silent action. ' +
            'Add speakers if the script has dialogue.',
        });
      }

      episodes.push({
        number,
        title:
          block.title ||
          (chunks.length > 1 ? `Imported part ${chunkIndex + 1}` : `Imported episode ${number}`),
        script: buildScript(chunk),
        warnings: episodeWarnings,
      });
    }
  }

  if (episodes.length === 0) {
    warnings.push({
      code: 'unparsed_tail',
      message: 'Nothing readable was found in that script.',
    });
  }

  const speakers: string[] = [];
  for (const episode of episodes) {
    for (const scene of episode.script.scenes) {
      for (const beat of scene.beats) {
        if (beat.speaker && !speakers.includes(beat.speaker)) speakers.push(beat.speaker);
      }
    }
  }

  return { episodes, warnings, speakers };
}
