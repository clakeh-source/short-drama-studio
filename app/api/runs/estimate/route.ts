import { z } from 'zod';
import { route } from '@/lib/api/handler';
import { describeEstimate, estimateRun } from '@/lib/runs/estimate';
import { getImageProvider, getTtsProvider, getVideoProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * What a run would cost, before starting one.
 *
 * Separate from `POST /api/runs` because the number has to move as the user
 * drags the length: quoting only at the moment of commitment tells someone what
 * they have already decided to spend, which is too late to be information.
 */
const querySchema = z.object({
  targetSeconds: z.coerce.number().int().min(30).max(600).default(180),
});

export const GET = route<undefined, z.infer<typeof querySchema>>(
  { operation: 'run.estimate', query: querySchema },
  async ({ query, user }) => {
    const estimate = estimateRun({
      targetSeconds: query.targetSeconds,
      video: getVideoProvider(),
      image: getImageProvider(),
      tts: getTtsProvider(),
    });

    /**
     * Judged against the worst case, which is the same test `POST /api/runs`
     * applies — so the button can be disabled up front rather than the request
     * refused after the user has committed to it.
     */
    const spend = await checkSpend(user.id, estimate.maxCents);

    return {
      estimate,
      summary: describeEstimate(estimate),
      spend,
      affordable: spend.allowed,
    };
  },
);
