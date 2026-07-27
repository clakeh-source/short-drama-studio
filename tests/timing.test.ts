import { describe, expect, it } from 'vitest';
import {
  countWords,
  dialogueWordBudget,
  driftFromTarget,
  estimateBeatSeconds,
  estimateSceneSeconds,
  estimateScriptSeconds,
  DIALOGUE_BEAT_OVERHEAD_SECONDS,
  SILENT_BEAT_SECONDS,
  WORDS_PER_SECOND,
} from '@/lib/timing';

describe('script timing model', () => {
  it('counts words, ignoring padding and empties', () => {
    expect(countWords('  You died   in March. ')).toBe(4);
    expect(countWords('')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });

  it('charges a silent beat a flat duration', () => {
    expect(estimateBeatSeconds({ action: 'She freezes.' })).toBe(SILENT_BEAT_SECONDS);
    expect(estimateBeatSeconds({ action: 'She freezes.', dialogue: null })).toBe(
      SILENT_BEAT_SECONDS,
    );
    expect(estimateBeatSeconds({ action: 'She freezes.', dialogue: '   ' })).toBe(
      SILENT_BEAT_SECONDS,
    );
  });

  it('charges a spoken beat its words plus staging overhead', () => {
    // 5 words at 2.5 w/s = 2s, plus 0.5s staging.
    const beat = { action: 'She turns.', dialogue: 'You died in March somehow' };
    expect(estimateBeatSeconds(beat)).toBeCloseTo(5 / WORDS_PER_SECOND + DIALOGUE_BEAT_OVERHEAD_SECONDS);
    expect(estimateBeatSeconds(beat)).toBeCloseTo(2.5);
  });

  it('sums beats into scenes and scenes into scripts', () => {
    const scene = {
      beats: [
        { action: 'a', dialogue: 'one two three four five' }, // 2.5s
        { action: 'b' }, // 2s
      ],
    };
    expect(estimateSceneSeconds(scene)).toBeCloseTo(4.5);
    expect(estimateScriptSeconds([scene, scene])).toBeCloseTo(9);
  });

  it('reports drift as a fraction of the target', () => {
    const scenes = [{ beats: [{ action: 'a' }, { action: 'b' }] }]; // 4s
    expect(driftFromTarget(scenes, 4)).toBeCloseTo(0);
    expect(driftFromTarget(scenes, 5)).toBeCloseTo(0.2);
    expect(driftFromTarget(scenes, 0)).toBe(0);
  });

  it('turns a target duration into a dialogue word budget', () => {
    // 60s * 2.5 w/s, discounted for action beats.
    expect(dialogueWordBudget(60)).toBe(120);
  });
});
