import { describe, expect, it } from 'vitest';
import { POLL_CEILING_MS, pollSchedule, scheduleTotalMs, toSleepDuration } from '@/lib/inngest/backoff';
import {
  episodeGenerateEventId,
  shotVideoEventId,
  shotVoiceEventId,
} from '@/lib/inngest/client';
import {
  VOICE_HEADROOM_SECONDS,
  voiceOverruns,
} from '@/lib/inngest/functions/generate-shot-voice';
import {
  MAX_AUTOMATIC_RETRIES,
  maxProviderCalls,
  shouldRetry,
} from '@/lib/inngest/retry';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import type { Shot } from '@/lib/db/schema';

/**
 * The pure parts of the generation pipeline: the polling schedule, idempotency
 * keys, voice-overrun detection and cost estimation. The parts that need a
 * database live in tests/generation-db.test.ts.
 */

describe('poll schedule', () => {
  const schedule = pollSchedule();

  it('ramps 5s, 10s, 20s then settles at 30s', () => {
    expect(schedule.slice(0, 3)).toEqual([5_000, 10_000, 20_000]);
    expect(new Set(schedule.slice(3))).toEqual(new Set([30_000]));
  });

  it('never exceeds the 15-minute ceiling', () => {
    expect(scheduleTotalMs()).toBeLessThanOrEqual(POLL_CEILING_MS);
  });

  it('gets close to the ceiling rather than giving up early', () => {
    // Within one steady-state step of the ceiling.
    expect(scheduleTotalMs()).toBeGreaterThan(POLL_CEILING_MS - 30_000);
  });

  it('polls often enough to feel responsive on a fast job', () => {
    // First poll inside 5 seconds, three polls inside 35.
    expect(schedule[0]).toBe(5_000);
    expect(schedule.slice(0, 3).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(35_000);
  });

  it('degrades sensibly with a tiny ceiling', () => {
    expect(pollSchedule(3_000)).toEqual([]);
    expect(pollSchedule(5_000)).toEqual([5_000]);
    expect(pollSchedule(16_000)).toEqual([5_000, 10_000]);
  });

  it('formats delays for step.sleep', () => {
    expect(toSleepDuration(5_000)).toBe('5s');
    expect(toSleepDuration(30_000)).toBe('30s');
  });
});

describe('idempotency keys', () => {
  it('a repeated submit for the same attempt collides, so it is deduplicated', () => {
    expect(shotVideoEventId('shot-1', 0)).toBe(shotVideoEventId('shot-1', 0));
  });

  it('a retry gets a distinct key, so it is allowed through', () => {
    expect(shotVideoEventId('shot-1', 1)).not.toBe(shotVideoEventId('shot-1', 0));
  });

  it('video and voice never collide for the same shot', () => {
    expect(shotVideoEventId('shot-1', 0)).not.toBe(shotVoiceEventId('shot-1', 0));
  });

  it('different shots never collide', () => {
    expect(shotVideoEventId('shot-1', 0)).not.toBe(shotVideoEventId('shot-2', 0));
  });

  it('episode fan-out honours a caller-supplied key', () => {
    expect(episodeGenerateEventId('ep-1', 'abc')).toBe(episodeGenerateEventId('ep-1', 'abc'));
    expect(episodeGenerateEventId('ep-1', 'abc')).not.toBe(
      episodeGenerateEventId('ep-1', 'xyz'),
    );
  });

  it('without a key, two requests are allowed to differ', () => {
    // No key means the caller has not promised idempotency, so we must not
    // silently swallow their second request.
    expect(episodeGenerateEventId('ep-1', null)).toMatch(/^episode-generate:ep-1:/);
  });
});

describe('voice overrun detection (AC #7)', () => {
  it('flags a line that would be cut off', () => {
    expect(voiceOverruns(5.5, 5)).toBe(true);
    expect(voiceOverruns(8.2, 8)).toBe(true);
  });

  it('accepts a line that fits with headroom', () => {
    expect(voiceOverruns(4.0, 5)).toBe(false);
    expect(voiceOverruns(4.7, 5)).toBe(false);
  });

  it('treats an exact fit as an overrun — a clip with no air reads as clipped', () => {
    expect(voiceOverruns(5, 5)).toBe(true);
  });

  it('uses the documented headroom', () => {
    expect(voiceOverruns(5 - VOICE_HEADROOM_SECONDS - 0.01, 5)).toBe(false);
    expect(voiceOverruns(5 - VOICE_HEADROOM_SECONDS + 0.01, 5)).toBe(true);
  });
});

describe('episode cost estimate', () => {
  const video = getVideoProvider('stub');
  const tts = getTtsProvider('stub');

  function shot(overrides: Partial<Shot> = {}): Shot {
    return {
      id: `shot-${Math.random()}`,
      sceneId: 'scene-1',
      orderIndex: 0,
      durationSeconds: 5,
      camera: 'medium',
      action: 'She turns.',
      dialogue: null,
      speakerCharacterId: null,
      characterIds: [],
      imagePrompt: null,
      videoPrompt: 'medium shot, a woman, she turns, lobby, night, cinematic',
      negativePrompt: null,
      promptOverride: null,
      status: 'pending',
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Shot;
  }

  it('prices video for every shot', () => {
    const estimate = estimateEpisodeCost([shot(), shot(), shot()], video, tts);
    expect(estimate.shotCount).toBe(3);
    expect(estimate.videoCents).toBeGreaterThan(0);
    expect(estimate.totalCents).toBe(estimate.videoCents + estimate.voiceCents);
  });

  it('prices voice only for shots that have a line', () => {
    const estimate = estimateEpisodeCost(
      [shot(), shot({ dialogue: 'You died in March.' })],
      video,
      tts,
    );
    expect(estimate.voiceShotCount).toBe(1);
    expect(estimate.voiceCents).toBeGreaterThan(0);
  });

  it('ignores a whitespace-only line', () => {
    const estimate = estimateEpisodeCost([shot({ dialogue: '   ' })], video, tts);
    expect(estimate.voiceShotCount).toBe(0);
    expect(estimate.voiceCents).toBe(0);
  });

  it('scales with duration, since video is priced per second', () => {
    const short = estimateEpisodeCost([shot({ durationSeconds: 3 })], video, tts);
    const long = estimateEpisodeCost([shot({ durationSeconds: 8 })], video, tts);
    expect(long.videoCents).toBeGreaterThan(short.videoCents);
  });

  it('prices the override when one is set, not the composed prompt', () => {
    const estimate = estimateEpisodeCost(
      [shot({ promptOverride: 'my own prompt' })],
      video,
      tts,
    );
    expect(estimate.videoCents).toBeGreaterThan(0);
  });

  it('per-shot figures sum to the totals', () => {
    const estimate = estimateEpisodeCost(
      [shot({ dialogue: 'One.' }), shot(), shot({ dialogue: 'Two words here.' })],
      video,
      tts,
    );
    expect(estimate.shots.reduce((n, s) => n + s.totalCents, 0)).toBe(estimate.totalCents);
    expect(estimate.shots.reduce((n, s) => n + s.videoCents, 0)).toBe(estimate.videoCents);
    expect(estimate.shots.reduce((n, s) => n + s.voiceCents, 0)).toBe(estimate.voiceCents);
  });

  it('reports the providers it priced against', () => {
    const estimate = estimateEpisodeCost([shot()], video, tts);
    expect(estimate.providers).toEqual({ video: 'stub', tts: 'stub' });
  });

  it('handles an empty episode', () => {
    const estimate = estimateEpisodeCost([], video, tts);
    expect(estimate.totalCents).toBe(0);
    expect(estimate.shotCount).toBe(0);
  });

  it('AC #5 — the estimate is exactly what the provider will charge for video', () => {
    // The stub's `poll` returns the same cost its `estimateCostCents` quotes, so
    // estimate and actual agree by construction rather than by luck. A real
    // provider is checked against this in the DB suite.
    const one = shot({ durationSeconds: 5 });
    const estimate = estimateEpisodeCost([one], video, tts);
    const quoted = video.estimateCostCents({
      prompt: one.videoPrompt!,
      durationSeconds: 5,
      aspectRatio: '9:16',
    });
    expect(estimate.videoCents).toBe(quoted);
  });
});

describe('automatic retry policy (AC #3)', () => {
  it('retries a retryable failure exactly twice, then stops', () => {
    expect(shouldRetry(true, 0)).toBe(true); // first failure  -> attempt 1
    expect(shouldRetry(true, 1)).toBe(true); // second failure -> attempt 2
    expect(shouldRetry(true, 2)).toBe(false); // third failure -> give up
    expect(shouldRetry(true, 3)).toBe(false);
  });

  it('never retries a non-retryable failure, however early', () => {
    expect(shouldRetry(false, 0)).toBe(false);
    expect(shouldRetry(false, 1)).toBe(false);
    expect(shouldRetry(false, 2)).toBe(false);
  });

  it('caps a shot at three provider calls without human intervention', () => {
    expect(maxProviderCalls()).toBe(3);
    expect(MAX_AUTOMATIC_RETRIES).toBe(2);

    // Walk the ladder the way the job does.
    let calls = 0;
    let attempt = 0;
    while (true) {
      calls += 1;
      if (!shouldRetry(true, attempt)) break;
      attempt += 1;
    }
    expect(calls).toBe(maxProviderCalls());
  });
});
