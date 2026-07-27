import { z } from 'zod';
import { badRequest } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { regenerateScene } from '@/lib/ai/script';
import { loadEpisode, parseBible, parseScript, persistScript } from '@/lib/data/series';
import { estimateScriptSeconds } from '@/lib/timing';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';

const bodySchema = z.object({
  note: z.string().max(500).optional(),
});

/**
 * Regenerates exactly one scene.
 *
 * The new scene is spliced into the stored script by index; every other scene
 * object is carried across by reference and re-serialised unchanged, which is
 * what makes them byte-identical afterwards (Phase 1 AC #4).
 */
export const POST = sseRoute<{ id: string; index: string }, z.infer<typeof bodySchema>>(
  { operation: 'script.regenerate_scene', body: bodySchema },
  async ({ body, params, user, send }) => {
    const { episode, series } = await loadEpisode(user.id, params.id);

    const bible = parseBible(series.bible);
    const script = parseScript(episode.script);
    if (!bible) throw badRequest('This series has no valid bible yet.');
    if (!script) throw badRequest('This episode has no script yet. Generate the script first.');

    const sceneIndex = Number.parseInt(params.index, 10);
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= script.scenes.length) {
      throw badRequest(`Scene ${params.index} does not exist in this episode.`);
    }

    const provider = getLlmProvider();
    send('status', { message: `Rewriting scene ${sceneIndex + 1}…` });

    const result = await regenerateScene({
      provider,
      bible,
      script,
      sceneIndex,
      episodeNumber: episode.number,
      language: series.language,
      ...(body.note ? { note: body.note } : {}),
      onDelta: (chunk) => send('delta', chunk),
    });

    const next = {
      ...script,
      scenes: script.scenes.map((scene, i) => (i === sceneIndex ? result.data : scene)),
    };

    send('status', { message: 'Saving…' });
    await persistScript(user.id, episode.id, next);

    await recordUsage({
      userId: user.id,
      seriesId: series.id,
      episodeId: episode.id,
      provider: provider.id,
      operation: 'script.regenerate_scene',
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    send('done', {
      script: next,
      sceneIndex,
      attempts: result.attempts,
      costCents: result.usage.costCents,
      estimatedSeconds: Math.round(estimateScriptSeconds(next.scenes)),
      targetSeconds: series.episodeTargetSeconds,
    });
  },
);

/**
 * Vercel's default function ceiling (15s on Pro) is far below what this route
 * needs: a scene rewrite is a full model round trip.
 *
 * Without it the request is killed mid-stream and the user sees a generation
 * that simply stops. 300s is the Vercel Pro maximum; see docs/DEPLOY.md.
 */
export const maxDuration = 300;
