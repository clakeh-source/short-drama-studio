import 'server-only';

import { ApiError, paymentRequired } from '@/lib/api/handler';
import { activeRender, buildEpisodeTimeline, listRenders } from '@/lib/data/render';
import { episodeRenderEventId, inngest } from '@/lib/inngest/client';
import { getRenderProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * Starting an assembly.
 *
 * Shared by `/assemble` and `/render`, which are the same operation under two
 * names — the spec calls it assembly, the codebase has called it rendering since
 * Phase 4, and having one of them be a thin alias is better than having two
 * implementations drift.
 */

/**
 * Refusal when the episode is not fully generated.
 *
 * 409 rather than 400: nothing about the *request* is malformed. The episode is
 * simply in a state where this cannot happen yet, and it will be able to later
 * without the caller changing anything — which is exactly what Conflict means.
 * The distinction matters to a client deciding whether to retry.
 */
export class EpisodeNotReadyError extends ApiError {
  constructor(
    message: string,
    readonly incompleteShotIds: string[],
    details: unknown,
  ) {
    super(409, 'episode_not_ready', message, details);
    this.name = 'EpisodeNotReadyError';
  }
}

export interface AssembleResult {
  queued: boolean;
  renderId?: string;
  message?: string;
  eventIds?: string[];
  estimateCents?: number;
  provider?: string;
  totalSeconds?: number;
  clipCount?: number;
  captionCount?: number;
}

export async function startAssembly(
  userId: string,
  episodeId: string,
): Promise<AssembleResult> {
  const inFlight = await activeRender(episodeId);
  if (inFlight) {
    return {
      queued: false,
      renderId: inFlight.id,
      message: 'An assembly is already running for this episode.',
    };
  }

  const built = await buildEpisodeTimeline(userId, episodeId);

  if (!built.readiness.ready) {
    const incompleteShotIds = built.readiness.blockingShots.map((s) => s.shotId);

    /**
     * Refuse before anything is submitted, and name the shots.
     *
     * The spec is explicit that a partial assembly must not be attempted, and
     * the reason is not tidiness: a half-episode that encodes successfully is
     * indistinguishable from a finished one at the file level, so it would be
     * uploaded, marked `rendered`, and discovered by a human watching it.
     */
    throw new EpisodeNotReadyError(
      built.readiness.clipCount === 0
        ? 'None of this episode’s shots have been generated yet, so there is nothing to assemble.'
        : `${incompleteShotIds.length} of ${built.readiness.shotCount} shots have no clip yet. ` +
          `Generate them before assembling.`,
      incompleteShotIds,
      {
        incompleteShotIds,
        // The richer form, for a UI that wants to say *why* each one is blocking.
        blockingShots: built.readiness.blockingShots,
        shotCount: built.readiness.shotCount,
        clipCount: built.readiness.clipCount,
      },
    );
  }

  const provider = getRenderProvider();
  const estimateCents = provider.estimateCostCents({
    clips: built.timeline.clips,
    voiceTracks: built.timeline.voiceTracks,
    captions: built.timeline.captions,
    aspectRatio: built.timeline.aspectRatio,
    resolution: built.timeline.resolution,
    ...(built.timeline.musicUrl ? { musicUrl: built.timeline.musicUrl } : {}),
  });

  const spend = await checkSpend(userId, estimateCents);
  if (!spend.allowed) {
    throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
  }

  // Every previous attempt, successful or not, advances the counter — so a
  // retry produces a distinct Inngest event id while a double-clicked button
  // produces the same one and is deduplicated.
  const previous = await listRenders(userId, episodeId);
  const attempt = previous.length;

  const { ids } = await inngest.send({
    id: episodeRenderEventId(episodeId, attempt),
    name: 'episode/render.requested',
    data: { userId, episodeId, attempt },
  });

  return {
    queued: true,
    eventIds: ids,
    estimateCents,
    provider: provider.id,
    totalSeconds: built.timeline.totalSeconds,
    clipCount: built.timeline.clips.length,
    captionCount: built.timeline.captions.length,
  };
}
