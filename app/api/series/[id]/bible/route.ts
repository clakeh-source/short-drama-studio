import { generateBible } from '@/lib/ai/bible';
import { assertLlmBudget } from '@/lib/ai/budget';
import { sseRoute } from '@/lib/api/sse';
import { notFound } from '@/lib/api/handler';
import { loadSeries } from '@/lib/data/series';
import { persistBible } from '@/lib/data/series';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { RATE_LIMITS } from '@/lib/rate-limit';

/** Generates (or regenerates) the series bible, streamed to the client. */
export const POST = sseRoute<{ id: string }>(
  {
    operation: 'bible.generate',
    rateLimit: RATE_LIMITS.model,
    preflight: ({ user }) => assertLlmBudget(user.id, getLlmProvider(), 'bible.generate'),
  },
  async ({ params, user, send }) => {
    const { series: row } = await loadSeries(user.id, params.id);
    if (!row) throw notFound('Series not found');

    const provider = getLlmProvider();
    send('status', { message: 'Developing the series bible…' });

    const result = await generateBible({
      provider,
      input: {
        premise: row.logline,
        genre: row.genre,
        tone: row.tone,
        audience: row.audience,
        language: row.language,
        episodeCount: row.episodeTargetCount,
        episodeSeconds: row.episodeTargetSeconds,
      },
      onDelta: (chunk) => send('delta', chunk),
    });

    send('status', { message: 'Saving…' });

    await persistBible(user.id, row.id, result.data);

    await recordUsage({
      userId: user.id,
      seriesId: row.id,
      provider: provider.id,
      operation: 'bible.generate',
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    send('done', {
      bible: result.data,
      attempts: result.attempts,
      costCents: result.usage.costCents,
    });
  },
);

/**
 * Vercel's default function ceiling (15s on Pro) is far below what this route
 * needs: a bible streams for ~38s at `effort: low`.
 *
 * Without it the request is killed mid-stream and the user sees a generation
 * that simply stops. 300s is the Vercel Pro maximum; see docs/DEPLOY.md.
 */
export const maxDuration = 300;
