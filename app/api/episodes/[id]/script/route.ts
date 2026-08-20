import { badRequest } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { assertLlmBudget } from '@/lib/ai/budget';
import { generateScript } from '@/lib/ai/script';
import {
  loadContinuitySummary,
  loadEpisode,
  parseBible,
  persistScript,
} from '@/lib/data/series';
import { driftFromTarget, estimateScriptSeconds } from '@/lib/timing';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { RATE_LIMITS } from '@/lib/rate-limit';

/** Writes (or rewrites) the whole episode script, streamed to the client. */
export const POST = sseRoute<{ id: string }>(
  {
    operation: 'script.generate',
    rateLimit: RATE_LIMITS.model,
    preflight: ({ user }) => assertLlmBudget(user.id, getLlmProvider(), 'script.generate'),
  },
  async ({ params, user, send }) => {
    const { episode, series } = await loadEpisode(user.id, params.id);

    const bible = parseBible(series.bible);
    if (!bible) {
      throw badRequest('This series has no valid bible yet. Generate the bible first.');
    }

    const provider = getLlmProvider();

    // Everything already written in this series. Empty for episode 1, and for a
    // series whose earlier episodes have not been scripted yet.
    const continuitySummary = await loadContinuitySummary(
      user.id,
      series.id,
      episode.number,
    );

    send('status', {
      message: continuitySummary
        ? `Writing episode ${episode.number}, picking up where ${episode.number - 1} left off…`
        : `Writing episode ${episode.number}…`,
    });

    const result = await generateScript({
      provider,
      bible,
      episodeNumber: episode.number,
      episodeSeconds: series.episodeTargetSeconds,
      language: series.language,
      ...(continuitySummary ? { continuitySummary } : {}),
      onDelta: (chunk) => send('delta', chunk),
    });

    send('status', { message: 'Saving…' });
    await persistScript(user.id, episode.id, result.data);

    await recordUsage({
      userId: user.id,
      seriesId: series.id,
      episodeId: episode.id,
      provider: provider.id,
      operation: 'script.generate',
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    send('done', {
      script: result.data,
      // Surfaced so the UI can say the episode was written in context, and so
      // Phase 5 AC #1 is assertable end to end.
      continuityChars: continuitySummary.length,
      attempts: result.attempts,
      costCents: result.usage.costCents,
      estimatedSeconds: Math.round(estimateScriptSeconds(result.data.scenes)),
      targetSeconds: series.episodeTargetSeconds,
      drift: Number(driftFromTarget(result.data.scenes, series.episodeTargetSeconds).toFixed(3)),
    });
  },
);

/**
 * Vercel's default function ceiling (15s on Pro) is far below what this route
 * needs: a 32k-token script runs well past a minute.
 *
 * Without it the request is killed mid-stream and the user sees a generation
 * that simply stops. 300s is the Vercel Pro maximum; see docs/DEPLOY.md.
 */
export const maxDuration = 300;
