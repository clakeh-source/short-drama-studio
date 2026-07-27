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
