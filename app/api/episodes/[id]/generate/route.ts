import { z } from 'zod';
import { badRequest, dynamicRoute, paymentRequired } from '@/lib/api/handler';
import { loadStoryboard } from '@/lib/data/storyboard';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { episodeGenerateEventId, inngest } from '@/lib/inngest/client';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

const bodySchema = z.object({
  /** Regenerate only these shots; omit for "everything still pending". */
  shotIds: z.array(z.uuid()).max(200).optional(),
});

/**
 * Kicks off generation for an episode.
 *
 * The spend cap is checked here as well as inside the job, so the user gets an
 * immediate, actionable 402 instead of a queued job that fails a second later.
 * The Inngest event id carries the caller's idempotency key, so a retried or
 * double-clicked request cannot enqueue the episode twice.
 */
export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'episode.generate', body: bodySchema },
  async ({ body, params, user, idempotencyKey }) => {
    const board = await loadStoryboard(user.id, params.id);
    const allShots = board.scenes.flatMap((s) => s.shots);

    if (allShots.length === 0) {
      throw badRequest('This episode has no shots yet. Break the script into shots first.');
    }

    const selected = body.shotIds?.length
      ? allShots.filter((s) => body.shotIds!.includes(s.id))
      : allShots.filter((s) => s.status !== 'ready');

    if (selected.length === 0) {
      return { queued: 0, message: 'Every shot is already generated.' };
    }

    const estimate = estimateEpisodeCost(selected, getVideoProvider(), getTtsProvider());
    const spend = await checkSpend(user.id, estimate.totalCents);

    if (!spend.allowed) {
      // 402: the request was understood and refused on cost. Nothing is queued.
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    const { ids } = await inngest.send({
      id: episodeGenerateEventId(params.id, idempotencyKey),
      name: 'episode/generate.requested',
      data: {
        userId: user.id,
        episodeId: params.id,
        ...(body.shotIds?.length ? { shotIds: body.shotIds } : {}),
      },
    });

    return {
      queued: selected.length,
      eventIds: ids,
      estimateCents: estimate.totalCents,
      spentCents: spend.spentCents,
      capCents: spend.capCents,
    };
  },
);
