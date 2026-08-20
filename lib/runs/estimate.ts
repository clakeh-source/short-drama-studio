import { CANONICAL_REFERENCE_SET_SIZE } from '@/lib/characters/references';
import { MAX_INFLIGHT_VIDEO_JOBS } from '@/lib/data/generation';
import { keyframesEnabled } from '@/lib/characters/keyframe';
import { shotCountRange } from '@/lib/shots';
import type { ImageProvider, TtsProvider, VideoProvider } from '@/lib/providers';

/**
 * What a run will cost, quoted before it starts.
 *
 * Everything else in this codebase estimates from rows that already exist — a
 * storyboard's shots, an episode's timeline. This one has nothing to work from
 * but a target length, because it is quoted *before the first cent is spent*,
 * which is the only moment the number can still change someone's mind.
 *
 * Pure and provider-injected, so it can be asserted without a network and
 * without a database.
 */

/** Cast size the bible tends to produce. Used only for the pre-flight quote. */
const TYPICAL_CAST = 4;

/** Words a second of finished drama carries, for the TTS estimate. */
const WORDS_PER_SECOND = 2.5;

/** Roughly how much of a short drama is someone speaking. */
const DIALOGUE_FRACTION = 0.6;

/**
 * What the language model costs across a whole run.
 *
 * Flat rather than modelled: bible, script and storyboard are three or four
 * calls whose cost is dominated by output tokens, and at a few cents each they
 * are noise beside thirty video clips. Quoting them precisely would add a lot of
 * arithmetic to a rounding error.
 */
const LLM_CENTS = 25;

/**
 * How long a hosted video model takes for one clip, in minutes.
 *
 * Kling is typically one to three minutes for a 5-second clip. Two is the middle
 * and it is only used to set expectations — nothing waits on this number, but
 * somebody about to start a 3-minute film deserves to know it is a 25-minute job
 * and not a 3-minute one. Without that, the first honest run looks hung.
 */
const MINUTES_PER_CLIP = 2;

/** Roughly what the writing and drawing stages cost in time, before filming. */
const SETUP_MINUTES = 3;

export interface RunEstimate {
  targetSeconds: number;
  /** The range the shot planner will aim between. */
  shots: { min: number; max: number; expected: number };
  characters: number;
  breakdown: {
    script: number;
    cast: number;
    /** Start frames, one per shot. */
    keyframes: number;
    video: number;
    voice: number;
    assembly: number;
  };
  /** What it will probably cost. */
  totalCents: number;
  /** What it could cost if the planner lands at the top of its shot range. */
  maxCents: number;
  /**
   * Roughly how long the run will take, in minutes.
   *
   * Dominated by filming, which is bounded by how many clips can be in flight at
   * once — so this moves with `VIDEO_CONCURRENCY`, not with the money.
   */
  minutes: number;
  concurrency: number;
}

export function estimateRun(input: {
  targetSeconds: number;
  video: VideoProvider;
  image: ImageProvider;
  tts: TtsProvider;
  /** Override when the cast is already known. */
  characterCount?: number;
}): RunEstimate {
  const { min, max } = shotCountRange(input.targetSeconds);

  // Shots are planned to fill the target, so the expected count is whatever
  // number of average-length clips covers it — not the midpoint of the range,
  // which would ignore how long each shot actually is.
  const clipSeconds = input.video.clampDuration(Math.round(input.targetSeconds / max) || 5);
  const expected = Math.min(max, Math.max(min, Math.ceil(input.targetSeconds / clipSeconds)));

  const characters = input.characterCount ?? TYPICAL_CAST;

  const perClip = input.video.estimateCostCents({
    prompt: '',
    durationSeconds: clipSeconds,
    aspectRatio: '9:16',
  });

  const cast = input.image.estimateCostCents({
    prompt: '',
    count: characters * CANONICAL_REFERENCE_SET_SIZE,
    aspectRatio: '9:16',
    // The set is identity-locked, which is the dearer rate.
    identityImageUrls: input.image.supportsIdentity ? ['reference'] : [],
  });

  /**
   * One keyframe per shot, drawn before the clip.
   *
   * Small against the video — a few percent — but real, and leaving it out
   * would understate every quote by exactly the amount that makes
   * multi-character shots work.
   */
  const keyframes = keyframesEnabled()
    ? input.image.estimateCostCents({
        prompt: '',
        count: expected,
        aspectRatio: '9:16',
        identityImageUrls: input.image.supportsIdentity ? ['reference'] : [],
      })
    : 0;

  // Only the spoken share of the runtime is synthesised.
  const spokenWords = Math.round(input.targetSeconds * DIALOGUE_FRACTION * WORDS_PER_SECOND);
  const voice = input.tts.estimateCostCents('x'.repeat(spokenWords * 5));

  const video = perClip * expected;

  // Assembly is one encode. Local ffmpeg is free; a cloud renderer is not, and
  // its own estimator needs a timeline that does not exist yet — so this is
  // deliberately absent rather than guessed at.
  const assembly = 0;

  const totalCents = LLM_CENTS + cast + keyframes + video + voice + assembly;

  return {
    targetSeconds: input.targetSeconds,
    shots: { min, max, expected },
    characters,
    breakdown: { script: LLM_CENTS, cast, keyframes, video, voice, assembly },
    totalCents,
    maxCents: LLM_CENTS + cast + keyframes + perClip * max + voice + assembly,
    minutes: SETUP_MINUTES + Math.ceil(expected / MAX_INFLIGHT_VIDEO_JOBS) * MINUTES_PER_CLIP,
    concurrency: MAX_INFLIGHT_VIDEO_JOBS,
  };
}

/** One line a person can read before committing money. */
export function describeEstimate(estimate: RunEstimate): string {
  const minutes = Math.round((estimate.targetSeconds / 60) * 10) / 10;
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    `About ${estimate.shots.expected} shots for a ${minutes}-minute film — ` +
    `${dollars(estimate.totalCents)}, up to ${dollars(estimate.maxCents)} if it runs long. ` +
    `Takes around ${estimate.minutes} minutes at ${estimate.concurrency} clips at a time.`
  );
}
