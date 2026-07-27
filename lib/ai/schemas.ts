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
  characters: z.array(bibleCharacterSchema).min(3).max(6),
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

export const sceneSchema = z.object({
  location: z.string().min(1).max(160),
  time_of_day: z.string().min(1).max(60),
  summary: z.string().min(1).max(600),
  beats: z.array(beatSchema).min(1).max(40),
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
