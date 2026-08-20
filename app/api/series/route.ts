import { badRequest, route } from '@/lib/api/handler';
import { assertLlmBudget } from '@/lib/ai/budget';
import { screenContent } from '@/lib/ai/safety';
import { createSeriesInputSchema } from '@/lib/ai/schemas';
import { withUserDb } from '@/lib/db';
import { series } from '@/lib/db/schema';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Creates a series from a premise.
 *
 * The content-safety gate runs here, before the row exists and before a single
 * token is spent on the bible — a refused premise costs the screening call and
 * nothing else.
 */
export const POST = route(
  { operation: 'series.create', body: createSeriesInputSchema, rateLimit: RATE_LIMITS.model },
  async ({ body, user }) => {
    const provider = getLlmProvider();

    // Screening is a model call like any other, so the cap decides whether it
    // happens — before it happens.
    await assertLlmBudget(user.id, provider, 'safety.screen', body.premise.length);

    const verdict = await screenContent({ provider, text: body.premise });

    if (verdict.costCents !== undefined) {
      await recordUsage({
        userId: user.id,
        provider: provider.id,
        operation: 'safety.screen',
        costCents: verdict.costCents,
        tokensIn: verdict.tokensIn ?? null,
        tokensOut: verdict.tokensOut ?? null,
      });
    }

    if (!verdict.allowed) {
      throw badRequest(
        verdict.reasons[0] ?? 'That premise cannot be generated.',
        { reasons: verdict.reasons },
      );
    }

    const [row] = await withUserDb(user.id, (tx) =>
      tx
        .insert(series)
        .values({
          userId: user.id,
          // Placeholders until the bible names the show.
          title: body.premise.slice(0, 60),
          logline: body.premise,
          genre: body.genre,
          tone: body.tone,
          audience: body.audience,
          language: body.language,
          episodeTargetCount: body.episodeCount,
          episodeTargetSeconds: body.episodeSeconds,
          status: 'draft',
        })
        .returning({ id: series.id }),
    );

    return { id: row!.id };
  },
);
