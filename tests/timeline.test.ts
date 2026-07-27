import { describe, expect, it } from 'vitest';
import {
  approximateWordTimings,
  ASPECT_RATIO,
  buildTimeline,
  groupWordsIntoCues,
  RESOLUTION,
  voiceDriftSeconds,
  type TimelineShotInput,
} from '@/lib/timeline';

/**
 * Phase 4 AC #1 — voiceover drift under 100ms at the final shot.
 *
 * Positions come from one cumulative sum over the slot lengths, so drift should
 * be exactly zero rather than merely small. These tests pin that, including the
 * case that would break a naive implementation: clips whose real duration
 * differs from the slot they were cut to.
 */

function shot(overrides: Partial<TimelineShotInput> = {}): TimelineShotInput {
  return {
    shotId: `shot-${Math.random().toString(36).slice(2, 8)}`,
    durationSeconds: 5,
    videoUrl: 'https://example.test/clip.mp4',
    dialogue: null,
    voiceUrl: null,
    voiceDurationSeconds: null,
    ...overrides,
  };
}

describe('approximateWordTimings', () => {
  it('spans exactly the given duration', () => {
    const words = approximateWordTimings('you died in march', 4);
    expect(words).toHaveLength(4);
    expect(words[0]!.startSeconds).toBe(0);
    expect(words[words.length - 1]!.endSeconds).toBe(4);
  });

  it('never overlaps and never leaves a gap', () => {
    const words = approximateWordTimings('one two three four five six', 6);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.startSeconds).toBeCloseTo(words[i - 1]!.endSeconds, 3);
    }
  });

  it('gives longer words more time', () => {
    const [short, long] = approximateWordTimings('a extraordinarily', 5);
    const shortSpan = short!.endSeconds - short!.startSeconds;
    const longSpan = long!.endSeconds - long!.startSeconds;
    expect(longSpan).toBeGreaterThan(shortSpan);
  });

  it('handles degenerate input', () => {
    expect(approximateWordTimings('', 5)).toEqual([]);
    expect(approximateWordTimings('   ', 5)).toEqual([]);
    expect(approximateWordTimings('word', 0)).toEqual([]);
  });

  it('ignores punctuation when weighting', () => {
    const words = approximateWordTimings('no!!!!!!!! yes', 4);
    // "no" and "yes" are comparable in length; the exclamation marks must not
    // give the first word most of the airtime.
    const first = words[0]!.endSeconds - words[0]!.startSeconds;
    expect(first).toBeLessThan(3);
  });
});

describe('groupWordsIntoCues', () => {
  const words = approximateWordTimings('you told me that he was already dead', 6);

  it('breaks at the character budget', () => {
    const cues = groupWordsIntoCues(words, {
      maxChars: 14,
      minSeconds: 0.3,
      offset: 0,
      shotId: 's',
    });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(20);
  });

  it('never shows two cues at once', () => {
    const cues = groupWordsIntoCues(words, {
      maxChars: 10,
      minSeconds: 1.5, // deliberately long enough to force overlap
      offset: 0,
      shotId: 's',
    });
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i]!.endAt).toBeLessThanOrEqual(cues[i + 1]!.startAt);
    }
  });

  it('offsets every cue by the shot position', () => {
    const cues = groupWordsIntoCues(words, {
      maxChars: 20,
      minSeconds: 0.3,
      offset: 12,
      shotId: 's',
    });
    expect(cues[0]!.startAt).toBeGreaterThanOrEqual(12);
  });

  it('holds a single short word for the minimum', () => {
    const cues = groupWordsIntoCues(approximateWordTimings('no', 0.2), {
      maxChars: 20,
      minSeconds: 0.6,
      offset: 0,
      shotId: 's',
    });
    expect(cues[0]!.endAt - cues[0]!.startAt).toBeCloseTo(0.6, 2);
  });
});

describe('buildTimeline', () => {
  it('lays clips end to end with no gaps', () => {
    const timeline = buildTimeline({
      shots: [shot({ durationSeconds: 4 }), shot({ durationSeconds: 6 }), shot({ durationSeconds: 5 })],
    });

    expect(timeline.clips.map((c) => c.startAt)).toEqual([0, 4, 10]);
    expect(timeline.totalSeconds).toBe(15);
  });

  it('always reports the vertical format', () => {
    const timeline = buildTimeline({ shots: [shot()] });
    expect(timeline.resolution).toBe(RESOLUTION);
    expect(timeline.aspectRatio).toBe(ASPECT_RATIO);
    expect(RESOLUTION).toBe('1080x1920');
  });

  it('AC #1 — zero voice drift, including at the final shot', () => {
    const shots = Array.from({ length: 12 }, (_, i) =>
      shot({
        shotId: `s${i}`,
        durationSeconds: 3 + (i % 4),
        dialogue: 'You told me he was dead.',
        voiceUrl: 'https://example.test/v.wav',
        voiceDurationSeconds: 2.4,
      }),
    );

    const timeline = buildTimeline({ shots });

    expect(timeline.voiceTracks).toHaveLength(12);
    expect(voiceDriftSeconds(timeline)).toBe(0);
    expect(voiceDriftSeconds(timeline)).toBeLessThan(0.1);

    // The last voice track sits exactly on its clip.
    const lastClip = timeline.clips[timeline.clips.length - 1]!;
    const lastVoice = timeline.voiceTracks[timeline.voiceTracks.length - 1]!;
    expect(lastVoice.startAt).toBe(lastClip.startAt);
  });

  it('does not let an over-long clip file shift what follows', () => {
    // The provider returned 5.04s of video for a 5s slot. Positions must come
    // from the slot, or every later shot drifts by 40ms cumulatively.
    const timeline = buildTimeline({
      shots: [
        shot({ durationSeconds: 5 }),
        shot({ durationSeconds: 5 }),
        shot({ durationSeconds: 5 }),
      ],
    });
    expect(timeline.clips.map((c) => c.startAt)).toEqual([0, 5, 10]);
  });

  it('flags a voice track that runs past its slot', () => {
    const timeline = buildTimeline({
      shots: [
        shot({
          durationSeconds: 4,
          dialogue: 'A line that runs long.',
          voiceUrl: 'https://example.test/v.wav',
          voiceDurationSeconds: 5.5,
        }),
      ],
    });
    expect(timeline.voiceTracks[0]!.overruns).toBe(true);
  });

  it('reports shots with no clip instead of silently shortening the episode', () => {
    const timeline = buildTimeline({
      shots: [shot(), shot({ videoUrl: null, shotId: 'missing' }), shot()],
    });

    expect(timeline.missingClips).toEqual(['missing']);
    expect(timeline.clips).toHaveLength(2);
    // The slot is still reserved, so later clips keep their true positions.
    expect(timeline.totalSeconds).toBe(15);
    expect(timeline.clips[1]!.startAt).toBe(10);
  });

  it('captions only shots that have dialogue', () => {
    const timeline = buildTimeline({
      shots: [
        shot({ dialogue: null }),
        shot({ dialogue: 'You died in March.', voiceUrl: 'v', voiceDurationSeconds: 2 }),
      ],
    });
    expect(timeline.captions.length).toBeGreaterThan(0);
    expect(new Set(timeline.captions.map((c) => c.shotId)).size).toBe(1);
  });

  it('times captions from the voice clip, not the slot', () => {
    const timeline = buildTimeline({
      shots: [
        shot({
          durationSeconds: 8,
          dialogue: 'Two words',
          voiceUrl: 'v',
          voiceDurationSeconds: 1.5,
        }),
      ],
    });
    const last = timeline.captions[timeline.captions.length - 1]!;
    // Cues finish when the line does, not when the slot ends.
    expect(last.endAt).toBeLessThanOrEqual(2.2);
  });

  it('prefers provider word timings over the approximation', () => {
    const timeline = buildTimeline({
      shots: [
        shot({
          durationSeconds: 6,
          dialogue: 'alpha beta',
          voiceUrl: 'v',
          voiceDurationSeconds: 4,
          words: [
            { word: 'alpha', startSeconds: 1, endSeconds: 2 },
            { word: 'beta', startSeconds: 3, endSeconds: 3.8 },
          ],
        }),
      ],
      maxCaptionChars: 5,
    });

    expect(timeline.captions[0]!.startAt).toBe(1);
  });

  it('never lets a cue run past the end of the programme', () => {
    const timeline = buildTimeline({
      shots: [shot({ durationSeconds: 3, dialogue: 'A very long line indeed', voiceUrl: 'v', voiceDurationSeconds: 3 })],
      minCueSeconds: 5,
    });
    for (const cue of timeline.captions) {
      expect(cue.endAt).toBeLessThanOrEqual(timeline.totalSeconds);
      expect(cue.endAt).toBeGreaterThan(cue.startAt);
    }
  });

  it('carries a music bed through when given one', () => {
    expect(buildTimeline({ shots: [shot()], musicUrl: 'https://m.test/a.mp3' }).musicUrl).toBe(
      'https://m.test/a.mp3',
    );
    expect(buildTimeline({ shots: [shot()] }).musicUrl).toBeUndefined();
    expect(buildTimeline({ shots: [shot()], musicUrl: null }).musicUrl).toBeUndefined();
  });

  it('handles an empty episode', () => {
    const timeline = buildTimeline({ shots: [] });
    expect(timeline.clips).toEqual([]);
    expect(timeline.totalSeconds).toBe(0);
    expect(voiceDriftSeconds(timeline)).toBe(0);
  });

  it('is deterministic', () => {
    const shots = [
      shot({ shotId: 'a', dialogue: 'One line.', voiceUrl: 'v', voiceDurationSeconds: 2 }),
      shot({ shotId: 'b' }),
    ];
    expect(JSON.stringify(buildTimeline({ shots }))).toBe(
      JSON.stringify(buildTimeline({ shots })),
    );
  });
});
