import { describe, expect, it } from 'vitest';
import {
  fitShotCount,
  fitShotDurations,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  shotCountRange,
  shotDurationDrift,
  supportedDurations,
  totalShotSeconds,
} from '@/lib/shots';
import { getVideoProvider } from '@/lib/providers';

const clamp = (seconds: number) => getVideoProvider('stub').clampDuration(seconds);

describe('supportedDurations', () => {
  it('derives the provider grid inside the shot range', () => {
    const grid = supportedDurations(clamp);
    expect(grid).toEqual([...grid].sort((a, b) => a - b));
    expect(grid[0]).toBeGreaterThanOrEqual(MIN_SHOT_SECONDS);
    expect(grid[grid.length - 1]!).toBeLessThanOrEqual(MAX_SHOT_SECONDS);
  });

  it('never returns an empty grid, even from a degenerate clamp', () => {
    expect(supportedDurations(() => 999)).toEqual([MIN_SHOT_SECONDS]);
  });
});

describe('fitShotDurations', () => {
  const grid = supportedDurations(clamp);

  it('returns one duration per shot, in order', () => {
    const result = fitShotDurations([4, 5, 6], 15, clamp);
    expect(result).toHaveLength(3);
  });

  it('only ever returns values on the provider grid', () => {
    const result = fitShotDurations([3.2, 4.9, 7.7, 12, 1], 30, clamp);
    for (const value of result) expect(grid).toContain(value);
  });

  it('hits a 60s target within 10% from a 12-shot board (AC #1)', () => {
    const requested = Array.from({ length: 12 }, () => 5);
    const fitted = fitShotDurations(requested, 60, clamp);

    expect(totalShotSeconds(fitted)).toBe(60);
    expect(shotDurationDrift(fitted, 60)).toBeLessThanOrEqual(0.1);
  });

  it('pulls a wildly over-long board back toward the target', () => {
    const requested = Array.from({ length: 15 }, () => 8); // 120s
    const fitted = fitShotDurations(requested, 60, clamp);
    expect(shotDurationDrift(fitted, 60)).toBeLessThanOrEqual(0.1);
  });

  it('pushes a too-short board up toward the target', () => {
    const requested = Array.from({ length: 15 }, () => 3); // 45s
    const fitted = fitShotDurations(requested, 60, clamp);
    expect(shotDurationDrift(fitted, 60)).toBeLessThanOrEqual(0.1);
  });

  it.each([30, 45, 60, 90, 120])('lands within 10%% of a %ds target', (target) => {
    const { min, max } = shotCountRange(target);
    for (const count of [min, Math.round((min + max) / 2), max]) {
      const fitted = fitShotDurations(Array.from({ length: count }, () => 5), target, clamp);
      expect(
        shotDurationDrift(fitted, target),
        `${count} shots for ${target}s gave ${totalShotSeconds(fitted)}s`,
      ).toBeLessThanOrEqual(0.1);
    }
  });

  it('cannot reach an impossible target, but gets as close as the grid allows', () => {
    // Two shots can never sum to 60s when the max is 8s each.
    const fitted = fitShotDurations([5, 5], 60, clamp);
    expect(totalShotSeconds(fitted)).toBe(MAX_SHOT_SECONDS * 2);
  });

  it('leaves durations alone when there is no target', () => {
    expect(fitShotDurations([4, 6], 0, clamp)).toEqual([4, 6]);
  });

  it('handles an empty board', () => {
    expect(fitShotDurations([], 60, clamp)).toEqual([]);
  });

  it('is deterministic', () => {
    const a = fitShotDurations([3, 7, 4, 8, 5], 40, clamp);
    const b = fitShotDurations([3, 7, 4, 8, 5], 40, clamp);
    expect(a).toEqual(b);
  });
});

describe('fitShotCount', () => {
  const shot = (seconds: number, action = 'a') => ({
    camera: 'medium',
    action,
    dialogue: null,
    speaker: null,
    characters: [] as string[],
    duration_seconds: seconds,
  });

  it('merges an over-covered board down into range', () => {
    // 26 shots across 4 scenes — what the stub actually produced for 60s.
    const scenes = [
      { shots: Array.from({ length: 8 }, () => shot(4)) },
      { shots: Array.from({ length: 7 }, () => shot(4)) },
      { shots: Array.from({ length: 6 }, () => shot(4)) },
      { shots: Array.from({ length: 5 }, () => shot(4)) },
    ];

    const fitted = fitShotCount(scenes, { min: 10, max: 20 });
    const total = fitted.reduce((n, s) => n + s.shots.length, 0);

    expect(total).toBeLessThanOrEqual(20);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('splits an under-covered board up into range', () => {
    const scenes = [{ shots: [shot(8), shot(8), shot(8)] }];
    const fitted = fitShotCount(scenes, { min: 6, max: 20 });

    expect(fitted[0]!.shots.length).toBeGreaterThanOrEqual(6);
    for (const s of fitted[0]!.shots) {
      expect(s.duration_seconds).toBeGreaterThanOrEqual(MIN_SHOT_SECONDS);
    }
  });

  it('never empties or drops a scene', () => {
    const scenes = [
      { shots: [shot(5)] },
      { shots: [shot(5)] },
      { shots: [shot(5)] },
      { shots: [shot(5)] },
      { shots: [shot(5)] },
    ];

    // A max below the scene count is impossible to honour without losing a scene.
    const fitted = fitShotCount(scenes, { min: 1, max: 2 });
    expect(fitted).toHaveLength(5);
    for (const scene of fitted) expect(scene.shots.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps dialogue and cast when it merges', () => {
    const scenes = [
      {
        shots: [
          { ...shot(3), dialogue: 'You died in March.', speaker: 'Mara', characters: ['Mara'] },
          { ...shot(3), characters: ['Dane'] },
          shot(8),
          shot(8),
        ],
      },
    ];

    const fitted = fitShotCount(scenes, { min: 1, max: 3 });
    const merged = fitted[0]!.shots[0]!;

    expect(merged.dialogue).toBe('You died in March.');
    expect(merged.speaker).toBe('Mara');
    expect(merged.characters).toEqual(['Mara', 'Dane']);
  });

  it('never produces a shot longer than the provider maximum', () => {
    const scenes = [{ shots: Array.from({ length: 10 }, () => shot(8)) }];
    const fitted = fitShotCount(scenes, { min: 1, max: 2 });
    for (const s of fitted[0]!.shots) {
      expect(s.duration_seconds).toBeLessThanOrEqual(MAX_SHOT_SECONDS);
    }
  });

  it('leaves an in-range board alone', () => {
    const scenes = [{ shots: Array.from({ length: 12 }, () => shot(5)) }];
    const fitted = fitShotCount(scenes, { min: 10, max: 20 });
    expect(fitted[0]!.shots).toHaveLength(12);
  });

  it('is deterministic', () => {
    const scenes = [{ shots: Array.from({ length: 25 }, (_, i) => shot(3 + (i % 6))) }];
    const a = fitShotCount(scenes, { min: 10, max: 20 });
    const b = fitShotCount(scenes, { min: 10, max: 20 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('shotCountRange', () => {
  it('asks for 10-20 shots at 60 seconds (AC #1)', () => {
    expect(shotCountRange(60)).toEqual({ min: 10, max: 20 });
  });

  it('scales with the target and never goes degenerate', () => {
    expect(shotCountRange(15).min).toBeGreaterThanOrEqual(2);
    expect(shotCountRange(120).max).toBeGreaterThan(shotCountRange(60).max);
  });
});
