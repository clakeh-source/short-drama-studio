import { dynamicRoute } from '@/lib/api/handler';
import { generateExportCopy } from '@/lib/ai/export';
import { loadEpisode, parseBible } from '@/lib/data/series';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';

/** Caption and hashtags for the post. One LLM call, from the episode's own synopsis. */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'export.caption' },
  async ({ params, user }) => {
    const { episode, series } = await loadEpisode(user.id, params.id);
    const bible = parseBible(series.bible);
    const provider = getLlmProvider();

    const result = await generateExportCopy({
      provider,
      seriesTitle: bible?.title ?? series.title,
      episodeNumber: episode.number,
      episodeTitle: episode.title || `Episode ${episode.number}`,
      synopsis: episode.synopsis,
      cliffhanger: episode.cliffhanger,
      language: series.language,
    });

    await recordUsage({
      userId: user.id,
      seriesId: series.id,
      episodeId: episode.id,
      provider: provider.id,
      operation: 'export.caption',
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    return { ...result.data, costCents: result.usage.costCents };
  },
);

/**
 * Short — one caption and a handful of hashtags — but still a blocking model
 * call, and a schema retry doubles it. Vercel's 15s Pro default is close enough
 * to bite, and the failure is worse than a slow response: Anthropic has already
 * billed the call by the time the function is killed, and `recordUsage` above
 * never runs, so the charge lands outside the ledger and outside the spend cap.
 *
 * 60s is generous for a caption and still fails fast if the provider hangs.
 */
export const maxDuration = 60;
