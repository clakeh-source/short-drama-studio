import { afterEach, describe, expect, it } from 'vitest';
import { describeEstimate, estimateRun } from '@/lib/runs/estimate';
import {
  DEFAULT_GATE_SECONDS,
  GATED_STAGES,
  gateSeconds,
  isGated,
  nextStage,
  STAGE_ORDER,
} from '@/lib/data/runs';
import { MAX_INFLIGHT_VIDEO_JOBS } from '@/lib/data/generation';
import { FalImageProvider } from '@/lib/providers/fal/image';
import { FalVideoProvider } from '@/lib/providers/fal/video';
import { StubTtsProvider } from '@/lib/providers/stub/tts';
import { shotCountRange } from '@/lib/shots';

/**
 * The unattended run's arithmetic and its stage machine.
 *
 * The estimate matters more than it looks: it is the only number a person sees
 * before committing real money, and a run that quotes $6 and spends $28 is worse
 * than one that quotes nothing. So it is asserted against the same providers the
 * run will actually use, not against a fixture.
 */

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function providers() {
  process.env.FAL_KLING_COST_CENTS_PER_SECOND = '9';
  process.env.FAL_IMAGE_COST_CENTS = '3';
  return {
    video: new FalVideoProvider(),
    image: new FalImageProvider(),
    tts: new StubTtsProvider(),
  };
}

describe('estimateRun', () => {
  it('quotes a three-minute film against the real provider rates', () => {
    const estimate = estimateRun({ targetSeconds: 180, ...providers() });

    expect(estimate.shots.expected).toBe(36);
    // 36 clips at 5s and 9c/s is where the overwhelming majority goes.
    expect(estimate.breakdown.video).toBe(1620);
    expect(estimate.breakdown.video / estimate.totalCents).toBeGreaterThan(0.8);
    expect(estimate.totalCents).toBeGreaterThan(1800);
    expect(estimate.totalCents).toBeLessThan(2100);
  });

  it('counts a keyframe for every shot', () => {
    const estimate = estimateRun({ targetSeconds: 180, ...providers() });

    // One start frame per clip, at the identity rate. Leaving it out would
    // understate every quote by exactly what makes multi-character shots work.
    expect(estimate.breakdown.keyframes).toBe(estimate.shots.expected * 5);
    expect(estimate.totalCents).toBe(
      estimate.breakdown.script +
        estimate.breakdown.cast +
        estimate.breakdown.keyframes +
        estimate.breakdown.video +
        estimate.breakdown.voice +
        estimate.breakdown.assembly,
    );
  });

  it('scales with the target length', () => {
    const { video, image, tts } = providers();
    const minute = estimateRun({ targetSeconds: 60, video, image, tts });
    const five = estimateRun({ targetSeconds: 300, video, image, tts });

    expect(five.totalCents).toBeGreaterThan(minute.totalCents * 4);
    expect(five.shots.expected).toBeGreaterThan(minute.shots.expected * 4);
  });

  it('quotes a worst case above the expected one', () => {
    const estimate = estimateRun({ targetSeconds: 180, ...providers() });

    // The planner is allowed to land anywhere in its range, and someone about to
    // spend $19 should be told it could be $30.
    expect(estimate.maxCents).toBeGreaterThan(estimate.totalCents);
    expect(estimate.shots.max).toBe(shotCountRange(180).max);
  });

  it('keeps the expected shot count inside the planner’s own range', () => {
    for (const seconds of [30, 60, 90, 180, 300, 600]) {
      const estimate = estimateRun({ targetSeconds: seconds, ...providers() });
      expect(estimate.shots.expected).toBeGreaterThanOrEqual(estimate.shots.min);
      expect(estimate.shots.expected).toBeLessThanOrEqual(estimate.shots.max);
    }
  });

  it('costs the cast as three stills each, at the identity rate', () => {
    const estimate = estimateRun({ targetSeconds: 180, characterCount: 5, ...providers() });
    // 5 characters x 3 canonical stills x 5c — the identity model, because the
    // set is generated hero-first and conditioned. Quoting the plain rate would
    // under-report every cast the autorun draws.
    expect(estimate.breakdown.cast).toBe(75);
  });

  it('describes itself in one line a person can act on', () => {
    const line = describeEstimate(estimateRun({ targetSeconds: 180, ...providers() }));

    expect(line).toMatch(/36 shots/);
    expect(line).toMatch(/3-minute/);
    expect(line).toMatch(/\$19\./);
    expect(line).toMatch(/\$30\./);
    // The gap between "a 3-minute film" and half an hour of waiting is where
    // someone decides the app has hung, so the time is part of the quote.
    expect(line).toMatch(/minutes at \d+ clips at a time/);
  });
});

describe('how long a run takes', () => {
  it('is dominated by filming, not by the target length', () => {
    const estimate = estimateRun({ targetSeconds: 180, ...providers() });

    // 36 clips, 3 at a time, ~2 minutes each — a 3-minute film is a ~25-minute
    // job. Quoting only the money would be quoting half the commitment.
    expect(estimate.minutes).toBeGreaterThan(20);
    expect(estimate.concurrency).toBeGreaterThanOrEqual(1);
  });

  it('scales with the shot count', () => {
    const { video, image, tts } = providers();
    const short = estimateRun({ targetSeconds: 60, video, image, tts });
    const long = estimateRun({ targetSeconds: 300, video, image, tts });

    expect(long.minutes).toBeGreaterThan(short.minutes);
  });

  it('reports the concurrency the wait is based on', () => {
    // Otherwise "25 minutes" is unactionable — the reader cannot tell that
    // raising VIDEO_CONCURRENCY is the lever.
    const estimate = estimateRun({ targetSeconds: 180, ...providers() });
    expect(estimate.concurrency).toBe(MAX_INFLIGHT_VIDEO_JOBS);
  });
});

describe('the stage machine', () => {
  it('runs the stages in production order and ends at done', () => {
    expect(STAGE_ORDER).toEqual([
      'bible',
      'cast',
      'script',
      'storyboard',
      'shots',
      'assemble',
      'done',
    ]);
  });

  it('advances one stage at a time', () => {
    expect(nextStage('bible')).toBe('cast');
    expect(nextStage('storyboard')).toBe('shots');
    expect(nextStage('assemble')).toBe('done');
  });

  it('terminates rather than wrapping around', () => {
    expect(nextStage('done')).toBe('done');
  });

  it('gates exactly where being wrong is expensive and invisible', () => {
    // The bible decides the cast and every scene; the shot list decides thirty
    // clips. Everything else is mechanical or cheap.
    expect(GATED_STAGES).toEqual(['bible', 'storyboard']);
    expect(isGated('bible')).toBe(true);
    expect(isGated('storyboard')).toBe(true);
    expect(isGated('cast')).toBe(false);
    expect(isGated('shots')).toBe(false);
  });

  it('never gates the stage that spends the money', () => {
    // Gating `shots` would pause *after* the storyboard was approved and before
    // anything was generated, which is the same moment the storyboard gate
    // already covers — two prompts for one decision.
    expect(isGated('shots')).toBe(false);
  });
});

describe('gate timing', () => {
  it('defaults to two minutes', () => {
    delete process.env.RUN_GATE_SECONDS;
    expect(gateSeconds()).toBe(DEFAULT_GATE_SECONDS);
    expect(DEFAULT_GATE_SECONDS).toBe(120);
  });

  it('takes a configured countdown', () => {
    process.env.RUN_GATE_SECONDS = '30';
    expect(gateSeconds()).toBe(30);
  });

  it('allows zero, which makes the run fully unattended', () => {
    process.env.RUN_GATE_SECONDS = '0';
    expect(gateSeconds()).toBe(0);
  });

  it('falls back rather than throwing on nonsense', () => {
    // A bad value here should not be able to stop someone starting a run.
    process.env.RUN_GATE_SECONDS = 'soon';
    expect(gateSeconds()).toBe(DEFAULT_GATE_SECONDS);

    process.env.RUN_GATE_SECONDS = '-5';
    expect(gateSeconds()).toBe(DEFAULT_GATE_SECONDS);
  });
});
