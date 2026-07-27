import 'server-only';

import type { Shot } from '@/lib/db/schema';
import type { TtsProvider, VideoProvider } from '@/lib/providers';

/**
 * The cost estimate shown before anything is generated.
 *
 * Priced through the same provider methods that Phase 3 will actually call, on
 * the same inputs, so the number in the panel and the number on the invoice are
 * derived from one source. Phase 2 AC #5 requires them to agree within 5%.
 */

export interface ShotEstimate {
  shotId: string;
  videoCents: number;
  voiceCents: number;
  totalCents: number;
}

export interface EpisodeEstimate {
  shots: ShotEstimate[];
  videoCents: number;
  voiceCents: number;
  totalCents: number;
  shotCount: number;
  /** Shots with dialogue, i.e. the ones that also need a voice clip. */
  voiceShotCount: number;
  totalSeconds: number;
  providers: { video: string; tts: string };
}

export function estimateEpisodeCost(
  shots: Shot[],
  video: VideoProvider,
  tts: TtsProvider,
): EpisodeEstimate {
  const perShot = shots.map((shot): ShotEstimate => {
    const videoCents = video.estimateCostCents({
      prompt: shot.promptOverride ?? shot.videoPrompt ?? '',
      negativePrompt: shot.negativePrompt ?? undefined,
      durationSeconds: shot.durationSeconds,
      aspectRatio: '9:16',
    });

    const dialogue = shot.dialogue?.trim();
    const voiceCents = dialogue ? tts.estimateCostCents(dialogue) : 0;

    return { shotId: shot.id, videoCents, voiceCents, totalCents: videoCents + voiceCents };
  });

  const videoCents = perShot.reduce((n, s) => n + s.videoCents, 0);
  const voiceCents = perShot.reduce((n, s) => n + s.voiceCents, 0);

  return {
    shots: perShot,
    videoCents,
    voiceCents,
    totalCents: videoCents + voiceCents,
    shotCount: shots.length,
    voiceShotCount: perShot.filter((s) => s.voiceCents > 0).length,
    totalSeconds: shots.reduce((n, s) => n + s.durationSeconds, 0),
    providers: { video: video.id, tts: tts.id },
  };
}
