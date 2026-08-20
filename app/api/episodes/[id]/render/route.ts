import { badRequest, dynamicRoute, paymentRequired } from '@/lib/api/handler';
import { activeRender, buildEpisodeTimeline, listRenders } from '@/lib/data/render';
import { loadEpisode } from '@/lib/data/series';
import { episodeRenderEventId, inngest } from '@/lib/inngest/client';
import { getRenderProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * Starts a render.
 *
 * Refuses up front when shots are missing clips, so the user gets "regenerate
 * shot 7" instead of a queued job that dies a second later. The attempt number
 * comes from how many renders already exist, which makes a retry a distinct
 * Inngest event while a double-click dedupes.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'episode.render' },
  async ({ params, user }) => {
    /**
     * Ownership first, and only then anything else.
     *
     * `activeRender` reads through the privileged handle and takes no user id —
     * it is written for the job side, where there is no session to read through.
     * Asking it first meant `POST /api/episodes/<someone-else's-id>/render`
     * answered "a render is already running", with their render's id in the
     * body: a small cross-tenant answer from an endpoint that should have none.
     *
     * `loadEpisode` reads through RLS and throws 404 on anything the caller does
     * not own, which is the cheapest way to establish that here — the timeline
     * build below would also do it, but it signs a URL per asset first, and the
     * double-click path should not pay for that to be told to stand down.
     */
    await loadEpisode(user.id, params.id);

    const inFlight = await activeRender(params.id);
    if (inFlight) {
      return {
        queued: false,
        renderId: inFlight.id,
        message: 'A render is already running for this episode.',
      };
    }

    const built = await buildEpisodeTimeline(user.id, params.id);

    if (!built.readiness.ready) {
      throw badRequest(
        built.readiness.clipCount === 0
          ? 'None of this episode’s shots have been generated yet.'
          : `${built.readiness.blockingShots.length} of ${built.readiness.shotCount} shots have no clip. ` +
            `Generate them before rendering.`,
        { blockingShots: built.readiness.blockingShots },
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

    const spend = await checkSpend(user.id, estimateCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    // Every previous attempt, successful or not, advances the counter — so a
    // retry produces a distinct Inngest event id while a double-clicked button
    // produces the same one and is deduplicated.
    const previous = await listRenders(user.id, params.id);
    const attempt = previous.length;

    const { ids } = await inngest.send({
      id: episodeRenderEventId(params.id, attempt),
      name: 'episode/render.requested',
      data: { userId: user.id, episodeId: params.id, attempt },
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
  },
);
