import { badRequest } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { assertLlmBudget } from '@/lib/ai/budget';
import { generateStoryboard } from '@/lib/ai/storyboard';
import { loadEpisode, parseBible, parseScript } from '@/lib/data/series';
import { persistStoryboard } from '@/lib/data/storyboard';
import { shotDurationDrift } from '@/lib/shots';
import { getLlmProvider, getVideoProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { RATE_LIMITS } from '@/lib/rate-limit';

/** Breaks the episode script into shots, streamed to the client. */
export const POST = sseRoute<{ id: string }>(
  {
    operation: 'storyboard.generate',
    rateLimit: RATE_LIMITS.model,
    preflight: ({ user }) => assertLlmBudget(user.id, getLlmProvider(), 'storyboard.generate'),
  },
  async ({ params, user, send }) => {
    const { episode, series } = await loadEpisode(user.id, params.id);

    const bible = parseBible(series.bible);
    const script = parseScript(episode.script);
    if (!bible) throw badRequest('This series has no valid bible yet.');
    if (!script) throw badRequest('Write the episode script before storyboarding it.');

    const llm = getLlmProvider();
    const video = getVideoProvider();

    send('status', { message: 'Planning coverage…' });

    const result = await generateStoryboard({
      provider: llm,
      bible,
      script,
      episodeNumber: episode.number,
      episodeSeconds: series.episodeTargetSeconds,
      onDelta: (chunk) => send('delta', chunk),
    });

    send('status', { message: 'Composing shot prompts…' });

    const persisted = await persistStoryboard({
      userId: user.id,
      episodeId: episode.id,
      bible,
      script,
      storyboard: result.data,
      episodeSeconds: series.episodeTargetSeconds,
      clampDuration: (seconds) => video.clampDuration(seconds),
    });

    await recordUsage({
      userId: user.id,
      seriesId: series.id,
      episodeId: episode.id,
      provider: llm.id,
      operation: 'storyboard.generate',
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    send('done', {
      ...persisted,
      attempts: result.attempts,
      costCents: result.usage.costCents,
      targetSeconds: series.episodeTargetSeconds,
      drift: Number(
        shotDurationDrift([persisted.totalSeconds], series.episodeTargetSeconds).toFixed(3),
      ),
    });
  },
);

/**
 * Vercel's default function ceiling (15s on Pro) is far below what this route
 * needs: a 32k-token storyboard runs well past a minute.
 *
 * Without it the request is killed mid-stream and the user sees a generation
 * that simply stops. 300s is the Vercel Pro maximum; see docs/DEPLOY.md.
 */
export const maxDuration = 300;
