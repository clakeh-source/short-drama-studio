import { z } from 'zod';
import { CAMERA_VOCABULARY } from './prompts';

/**
 * The contracts the model output must satisfy. These are the arbiter of a
 * "valid bible" and a "valid script" — nothing downstream trusts raw model
 * text. Field names are snake_case because that is what the model is asked to
 * emit; the API layer maps to camelCase before it touches the database.
 */

export { CAMERA_VOCABULARY };

/* -------------------------------------------------------------------------- */
/* Series bible                                                               */
/* -------------------------------------------------------------------------- */

/** Shared with the editor so its counter cannot drift from the real limit. */
export const APPEARANCE_PROMPT_MAX = 1000;

export const bibleCharacterSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(60),
  description: z.string().min(1).max(1000),
  /**
   * Reused verbatim in every shot prompt the character appears in, so it must
   * be a self-contained visual description — no story, no names, no camera.
   */
  appearance_prompt: z.string().min(20).max(APPEARANCE_PROMPT_MAX),
});

export const bibleEpisodeSchema = z.object({
  number: z.int().min(1),
  title: z.string().min(1).max(120),
  /**
   * Generous on purpose. The first live runs returned 600-1200 character
   * synopses and the retry could not shorten them reliably, so every bible
   * failed validation. The prompt now states a target length; this is the
   * ceiling, not the goal.
   */
  synopsis: z.string().min(1).max(1500),
});

export const bibleSchema = z.object({
  title: z.string().min(1).max(120),
  logline: z.string().min(1).max(500),
  world: z.string().min(1).max(3000),
  tone_rules: z.array(z.string().min(1).max(400)).min(2).max(10),
  /**
   * The generate path's prompt asks for 3-6; this rail is wider because an
   * imported script's cast is however many people speak in it, and forking the
   * bible shape per source would put a branch in everything downstream that
   * reads a character. One or two speakers is a real two-hander, not an error.
   */
  characters: z.array(bibleCharacterSchema).min(1).max(12),
  season_arc: z.string().min(1).max(3000),
  episodes: z.array(bibleEpisodeSchema).min(1).max(50),
  /**
   * Series-level look, appended verbatim to every shot prompt. Optional so
   * bibles written before Phase 2 still parse; the composer falls back to a
   * sensible default when it is missing.
   */
  visual_style: z.string().max(400).optional(),
});

export type Bible = z.infer<typeof bibleSchema>;
export type BibleCharacter = z.infer<typeof bibleCharacterSchema>;

/* -------------------------------------------------------------------------- */
/* Episode script                                                             */
/* -------------------------------------------------------------------------- */

export const beatSchema = z.object({
  action: z.string().min(1).max(600),
  dialogue: z.string().max(400).nullable().optional(),
  speaker: z.string().max(80).nullable().optional(),
});

/**
 * What the importer could not work out for itself.
 *
 * Carried on the scene rather than alongside it so a warning cannot drift from
 * the scene it describes, and optional so an AI-written script — which has no
 * parse step — validates against exactly the same schema. The pipeline reads
 * `scenes[]` and ignores this; it exists for the confirm screen to flag.
 */
export const parseWarningSchema = z.object({
  code: z.enum([
    'inferred_scene_break',
    'missing_slugline',
    'unattributed_dialogue',
    'no_speakers_found',
    'unparsed_tail',
    'auto_split_episodes',
    'too_many_scenes',
  ]),
  message: z.string().min(1).max(300),
});

export const sceneSchema = z.object({
  location: z.string().min(1).max(160),
  time_of_day: z.string().min(1).max(60),
  summary: z.string().min(1).max(600),
  beats: z.array(beatSchema).min(1).max(40),
  /** Present only on imported scenes the parser was unsure about. */
  parse_warnings: z.array(parseWarningSchema).max(10).optional(),
});

export const scriptSchema = z.object({
  /** Must land inside the first 3 seconds. */
  hook: z.string().min(1).max(500),
  /** The final line. */
  cliffhanger: z.string().min(1).max(500),
  scenes: z.array(sceneSchema).min(1).max(12),
});

export type Script = z.infer<typeof scriptSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type ParseWarning = z.infer<typeof parseWarningSchema>;

/**
 * Where an episode's script came from.
 *
 * Stored on the series because it is a property of how the show is being made,
 * not of any one episode — and because the choice is made at creation, before
 * an episode row exists. The script *shape* is identical either way, which is
 * the point: nothing downstream branches on this.
 */
export const SCRIPT_SOURCES = ['generated', 'user_provided'] as const;
export const scriptSourceSchema = z.enum(SCRIPT_SOURCES);
export type ScriptSource = z.infer<typeof scriptSourceSchema>;

/* -------------------------------------------------------------------------- */
/* Storyboard                                                                 */
/* -------------------------------------------------------------------------- */

export const storyboardShotSchema = z.object({
  camera: z.enum(CAMERA_VOCABULARY),
  action: z.string().min(1).max(600),
  dialogue: z.string().max(400).nullable().optional(),
  speaker: z.string().max(80).nullable().optional(),
  /** Character names, matching the bible. Empty for an insert or a plate. */
  characters: z.array(z.string().max(80)).max(6),
  /** Intent only — refitted to the provider's grid and the episode budget. */
  duration_seconds: z.number().min(1).max(20),
});

export const storyboardSceneSchema = z.object({
  scene_index: z.int().min(0),
  shots: z.array(storyboardShotSchema).min(1).max(20),
});

export const storyboardSchema = z.object({
  scenes: z.array(storyboardSceneSchema).min(1).max(12),
});

export type StoryboardShot = z.infer<typeof storyboardShotSchema>;
export type StoryboardScene = z.infer<typeof storyboardSceneSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;

/* -------------------------------------------------------------------------- */
/* Content safety                                                             */
/* -------------------------------------------------------------------------- */

export const safetyVerdictSchema = z.object({
  allowed: z.boolean(),
  reasons: z.array(z.string().max(300)).max(10),
});

export type SafetyVerdict = z.infer<typeof safetyVerdictSchema>;

/* -------------------------------------------------------------------------- */
/* Series creation input (shared by the API route and the wizard)             */
/* -------------------------------------------------------------------------- */

export const createSeriesInputSchema = z.object({
  premise: z.string().min(10, 'Give the premise at least a sentence.').max(500),
  genre: z.string().min(1).max(60),
  tone: z.string().min(1).max(60),
  audience: z.string().min(1).max(60),
  language: z.string().min(2).max(20).default('en'),
  episodeCount: z.coerce.number().int().min(1).max(50),
  episodeSeconds: z.coerce.number().int().min(15).max(300),
});

export type CreateSeriesInput = z.infer<typeof createSeriesInputSchema>;

/**
 * Committing a script the user brought.
 *
 * There is no premise: the script *is* the premise, and the bible is derived
 * from it. Everything else matches `createSeriesInputSchema`, because a series
 * is a series once it exists — the two flows differ only in how they start.
 *
 * `episodes[].script` is the shape the user confirmed on the preview screen,
 * which may differ from what the parser produced; the preview is an editor, not
 * a receipt.
 */
export const importScriptInputSchema = z.object({
  genre: z.string().min(1).max(60),
  tone: z.string().min(1).max(60),
  audience: z.string().min(1).max(60),
  language: z.string().min(2).max(20).default('en'),
  episodeSeconds: z.coerce.number().int().min(15).max(300),
  episodes: z
    .array(
      z.object({
        number: z.int().min(1),
        title: z.string().max(120).default(''),
        script: scriptSchema,
      }),
    )
    .min(1)
    .max(50),
});

export type ImportScriptInput = z.infer<typeof importScriptInputSchema>;
