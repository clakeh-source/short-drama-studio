/**
 * Script duration estimation.
 *
 * Pure and dependency-free so it can be shared by the AI layer, the stub
 * provider, the storyboard planner (Phase 2) and unit tests. This is the model
 * the whole build agrees on for "how long will this play?" — Phase 1 AC #2 is
 * measured with exactly these numbers.
 */

/** Delivery rate for spoken dialogue in short-form drama. */
export const WORDS_PER_SECOND = 2.5;

/** A beat with no dialogue is a piece of pure action — it still takes time. */
export const SILENT_BEAT_SECONDS = 2;

/** Staging around a spoken line: the look, the turn, the beat before the reply. */
export const DIALOGUE_BEAT_OVERHEAD_SECONDS = 0.5;

export interface TimedBeat {
  action?: string | null;
  dialogue?: string | null;
}

export interface TimedScene {
  beats: TimedBeat[];
}

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function estimateBeatSeconds(beat: TimedBeat): number {
  const words = countWords(beat.dialogue);
  if (words === 0) return SILENT_BEAT_SECONDS;
  return words / WORDS_PER_SECOND + DIALOGUE_BEAT_OVERHEAD_SECONDS;
}

export function estimateSceneSeconds(scene: TimedScene): number {
  return scene.beats.reduce((total, beat) => total + estimateBeatSeconds(beat), 0);
}

export function estimateScriptSeconds(scenes: TimedScene[]): number {
  return scenes.reduce((total, scene) => total + estimateSceneSeconds(scene), 0);
}

/** Fraction the estimate is off target, e.g. 0.08 for 8% long or short. */
export function driftFromTarget(scenes: TimedScene[], targetSeconds: number): number {
  if (targetSeconds <= 0) return 0;
  return Math.abs(estimateScriptSeconds(scenes) - targetSeconds) / targetSeconds;
}

/**
 * Roughly how many dialogue words fit in a target duration, assuming most beats
 * carry a line. Used to give the model a concrete budget in the prompt rather
 * than asking it to "aim for about 60 seconds".
 */
export function dialogueWordBudget(targetSeconds: number): number {
  return Math.round(targetSeconds * WORDS_PER_SECOND * 0.8);
}

/**
 * Concrete structural targets for a duration.
 *
 * Asking for "about 60 seconds" produced a single 45-second scene on the live
 * model — it will not do the arithmetic. Counting scenes and beats is something
 * it can follow directly, so the prompt states those instead.
 *
 * Derived from the same cost model as the estimator: a typical beat carrying a
 * short line costs about 3.5s, so beats ≈ target / 3.5.
 */
export const TYPICAL_BEAT_SECONDS = 3.5;

export function scriptShape(targetSeconds: number): {
  scenes: number;
  beatsPerScene: { min: number; max: number };
  totalBeats: number;
} {
  const totalBeats = Math.max(3, Math.round(targetSeconds / TYPICAL_BEAT_SECONDS));
  // Short drama runs 15-25 seconds per scene.
  const scenes = Math.max(1, Math.min(6, Math.round(targetSeconds / 20)));
  const perScene = totalBeats / scenes;

  return {
    scenes,
    beatsPerScene: {
      min: Math.max(2, Math.floor(perScene) - 1),
      max: Math.max(3, Math.ceil(perScene) + 1),
    },
    totalBeats,
  };
}
