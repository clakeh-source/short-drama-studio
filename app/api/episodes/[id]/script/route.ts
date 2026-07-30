import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, dynamicRoute } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { generateScript } from '@/lib/ai/script';
import { withUserDb } from '@/lib/db';
import { episodes } from '@/lib/db/schema';
import {
  loadContinuitySummary,
  loadEpisode,
  parseBible,
  persistScript,
} from '@/lib/data/series';
import { driftFromTarget, estimateScriptSeconds } from '@/lib/timing';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';

/**
 * Setting an episode's script.
 *
 * One resource, two ways to fill it, chosen by whether the caller brought a
 * script of their own:
 *
 *   POST with a JSON body `{ text }`  →  store that script, verbatim
 *   POST with no body                 →  write one, streamed back as SSE
 *
 * They are the same operation from the user's point of view — "this episode's
 * script is now X" — so they share a path. They cannot share a handler, because
 * one returns a JSON document and the other an event stream.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  return contentType.includes('application/json')
    ? ingestScript(request, context)
    : generateEpisodeScript(request, context);
}

const ingestSchema = z.object({
  /**
   * The screenplay as written. Stored untouched — the breakdown in
   * /api/episodes/:id/breakdown is what interprets it, and it needs the
   * original rather than an interpretation of it.
   */
  text: z.string().min(1).max(400_000),
});

const ingestScript = dynamicRoute<{ id: string }, z.infer<typeof ingestSchema>>(
  { operation: 'script.ingest', body: ingestSchema },
  async ({ body, params, user }) => {
    const text = body.text.trim();
    if (!text) throw badRequest('That script is empty.');

    // Confirms the episode exists and is this user's, through RLS.
    const { episode } = await loadEpisode(user.id, params.id);

    const [row] = await withUserDb(user.id, (tx) =>
      tx
        .update(episodes)
        .set({
          scriptText: text,
          // The board is built from the script, so a new script means the
          // existing one is stale. Saying so is honest; rebuilding it here
          // without being asked would not be.
          status: episode.status === 'draft' ? 'scripted' : episode.status,
        })
        .where(eq(episodes.id, params.id))
        .returning({ id: episodes.id, status: episodes.status }),
    );

    return {
      stored: true,
      episodeId: row!.id,
      status: row!.status,
      characters: text.length,
      /** Truthy when a previous breakdown of a different script is still on the board. */
      breakdownMayBeStale: episode.status === 'storyboarded',
    };
  },
);

/** Writes (or rewrites) the whole episode script, streamed to the client. */
const generateEpisodeScript = sseRoute<{ id: string }>(
  { operation: 'script.generate' },
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
