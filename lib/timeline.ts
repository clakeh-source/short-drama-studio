/**
 * The timeline builder.
 *
 * Pure and dependency-free: given ordered shots and their generated assets, it
 * computes exactly where every clip, voice track and caption cue sits. Both
 * render adapters consume the same structure, which is what makes swapping
 * `RENDER_PROVIDER` a no-op for the rest of the app (Phase 4 AC #4).
 *
 * Positions are computed by cumulative sum from a single source, so there is no
 * accumulated timing error — Phase 4 AC #1 asks for voiceover drift under 100ms
 * at the final shot, and by construction it is zero.
 */

export const RESOLUTION = '1080x1920' as const;
export const ASPECT_RATIO = '9:16' as const;
export const FRAME_RATE = 30;

/** Rounding floor. Sub-millisecond positions are noise in a 30fps timeline. */
const PRECISION = 3;

function round(seconds: number): number {
  return Number(seconds.toFixed(PRECISION));
}

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

export interface TimelineWord {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TimelineShotInput {
  shotId: string;
  /** Slot length on the timeline. The clip is cut to this. */
  durationSeconds: number;
  /** Playback URL for the generated clip. */
  videoUrl: string | null;
  dialogue: string | null;
  voiceUrl: string | null;
  /** Measured length of the voice clip, which may exceed the slot. */
  voiceDurationSeconds: number | null;
  /** Provider-reported alignment, when available. */
  words?: TimelineWord[];
}

export interface BuildTimelineOptions {
  shots: TimelineShotInput[];
  musicUrl?: string | null;
  /** Longest a single caption cue may be, in characters. */
  maxCaptionChars?: number;
  /** Minimum a cue stays on screen, so single words are still readable. */
  minCueSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

export interface TimelineClip {
  shotId: string;
  url: string;
  durationSeconds: number;
  startAt: number;
}

export interface TimelineVoiceTrack {
  shotId: string;
  url: string;
  startAt: number;
  durationSeconds: number;
  /** True when the line is longer than its slot — flagged in Phase 3. */
  overruns: boolean;
}

export interface TimelineCaption {
  shotId: string;
  text: string;
  startAt: number;
  endAt: number;
}

export interface Timeline {
  clips: TimelineClip[];
  voiceTracks: TimelineVoiceTrack[];
  captions: TimelineCaption[];
  musicUrl?: string;
  totalSeconds: number;
  aspectRatio: typeof ASPECT_RATIO;
  resolution: typeof RESOLUTION;
  /** Shots with no clip yet — the render cannot proceed until these are done. */
  missingClips: string[];
}

const DEFAULT_MAX_CAPTION_CHARS = 28;
const DEFAULT_MIN_CUE_SECONDS = 0.6;

/* -------------------------------------------------------------------------- */
/* Word timing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Distributes a duration across words in proportion to their length.
 *
 * Used when the TTS provider reports no alignment. Longer words genuinely take
 * longer to say, so length-weighting beats an even split — but this is an
 * approximation, and a provider that returns real timings should always win.
 */
export function approximateWordTimings(
  text: string,
  durationSeconds: number,
): TimelineWord[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSeconds <= 0) return [];

  const weights = words.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let cursor = 0;
  return words.map((word, i) => {
    const share = (weights[i]! / totalWeight) * durationSeconds;
    const startSeconds = round(cursor);
    cursor += share;
    // Snap the last word to the exact end so cues never drift past the audio.
    const endSeconds = i === words.length - 1 ? round(durationSeconds) : round(cursor);
    return { word, startSeconds, endSeconds };
  });
}

/* -------------------------------------------------------------------------- */
/* Captions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Groups words into caption cues.
 *
 * Short-drama captions are read at a glance on a phone, so cues are short: a
 * few words, broken at the character budget. Each cue inherits its start from
 * the first word and its end from the last, so the text is on screen exactly
 * while it is being spoken.
 */
export function groupWordsIntoCues(
  words: TimelineWord[],
  options: { maxChars: number; minSeconds: number; offset: number; shotId: string },
): TimelineCaption[] {
  const cues: TimelineCaption[] = [];
  let bucket: TimelineWord[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const startAt = round(options.offset + first.startSeconds);
    const naturalEnd = round(options.offset + last.endSeconds);

    cues.push({
      shotId: options.shotId,
      text: bucket.map((w) => w.word).join(' '),
      startAt,
      // Never flash a cue for less than the minimum, even for one short word.
      endAt: round(Math.max(naturalEnd, startAt + options.minSeconds)),
    });
    bucket = [];
  };

  for (const word of words) {
    const candidate = [...bucket, word].map((w) => w.word).join(' ');
    if (bucket.length > 0 && candidate.length > options.maxChars) flush();
    bucket.push(word);
  }
  flush();

  // A cue extended by the minimum can overlap the next one; pull it back so no
  // two cues are ever on screen at once.
  for (let i = 0; i < cues.length - 1; i++) {
    const current = cues[i]!;
    const next = cues[i + 1]!;
    if (current.endAt > next.startAt) current.endAt = next.startAt;
  }

  return cues;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

export function buildTimeline(options: BuildTimelineOptions): Timeline {
  const maxChars = options.maxCaptionChars ?? DEFAULT_MAX_CAPTION_CHARS;
  const minSeconds = options.minCueSeconds ?? DEFAULT_MIN_CUE_SECONDS;

  const clips: TimelineClip[] = [];
  const voiceTracks: TimelineVoiceTrack[] = [];
  const captions: TimelineCaption[] = [];
  const missingClips: string[] = [];

  let cursor = 0;

  for (const shot of options.shots) {
    const startAt = round(cursor);

    if (shot.videoUrl) {
      clips.push({
        shotId: shot.shotId,
        url: shot.videoUrl,
        durationSeconds: shot.durationSeconds,
        startAt,
      });
    } else {
      missingClips.push(shot.shotId);
    }

    const dialogue = shot.dialogue?.trim();

    if (shot.voiceUrl && shot.voiceDurationSeconds !== null) {
      voiceTracks.push({
        shotId: shot.shotId,
        url: shot.voiceUrl,
        startAt,
        durationSeconds: shot.voiceDurationSeconds,
        overruns: shot.voiceDurationSeconds > shot.durationSeconds,
      });
    }

    if (dialogue) {
      // Prefer provider alignment; fall back to the measured voice duration;
      // fall back again to the slot length when there is no voice at all.
      const spoken =
        shot.voiceDurationSeconds !== null && shot.voiceDurationSeconds > 0
          ? Math.min(shot.voiceDurationSeconds, shot.durationSeconds)
          : shot.durationSeconds;

      const words =
        shot.words && shot.words.length > 0
          ? shot.words
          : approximateWordTimings(dialogue, spoken);

      captions.push(
        ...groupWordsIntoCues(words, {
          maxChars,
          minSeconds,
          offset: startAt,
          shotId: shot.shotId,
        }),
      );
    }

    // Cumulative from the slot length, never from the clip's own metadata, so a
    // provider returning a 5.04s file for a 5s slot cannot shift everything
    // after it.
    cursor += shot.durationSeconds;
  }

  // A cue can only ever run to the end of the programme.
  const totalSeconds = round(cursor);
  for (const cue of captions) {
    if (cue.endAt > totalSeconds) cue.endAt = totalSeconds;
  }

  return {
    clips,
    voiceTracks,
    captions: captions.filter((c) => c.endAt > c.startAt),
    ...(options.musicUrl ? { musicUrl: options.musicUrl } : {}),
    totalSeconds,
    aspectRatio: ASPECT_RATIO,
    resolution: RESOLUTION,
    missingClips,
  };
}

/**
 * Drift between where a voice track was placed and where its shot actually
 * starts. Phase 4 AC #1 requires this under 100ms at the final shot.
 */
export function voiceDriftSeconds(timeline: Timeline): number {
  let worst = 0;
  for (const track of timeline.voiceTracks) {
    const clip = timeline.clips.find((c) => c.shotId === track.shotId);
    if (!clip) continue;
    worst = Math.max(worst, Math.abs(track.startAt - clip.startAt));
  }
  return worst;
}
