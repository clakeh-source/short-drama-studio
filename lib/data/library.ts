import 'server-only';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { withUserDb } from '@/lib/db';
import { episodes, renders, series } from '@/lib/db/schema';
import { signedUrls } from '@/lib/storage';

/**
 * Every episode the user has, across every series, with whatever has been
 * rendered from it.
 *
 * Episodes without a render are included rather than filtered out: the Library is
 * where you go to find an episode, and hiding the unfinished ones makes a series
 * look like it has fewer episodes than it does.
 */

export interface LibraryEpisode {
  episodeId: string;
  seriesId: string;
  seriesTitle: string;
  number: number;
  title: string;
  status: string;
  /** Latest ready render, if any. */
  downloadUrl: string | null;
  durationSeconds: number | null;
  renderedAt: string | null;
  renderCount: number;
  /** True once there is something to watch and download. */
  hasVideo: boolean;
}

export interface Library {
  episodes: LibraryEpisode[];
  /** Distinct statuses present, so the filter only offers real options. */
  statuses: string[];
  seriesCount: number;
  renderedCount: number;
}

export async function loadLibrary(userId: string): Promise<Library> {
  const rows = await withUserDb(userId, async (tx) => {
    const episodeRows = await tx
      .select({
        episodeId: episodes.id,
        seriesId: series.id,
        seriesTitle: series.title,
        number: episodes.number,
        title: episodes.title,
        status: episodes.status,
      })
      .from(episodes)
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .orderBy(desc(series.createdAt), episodes.number);

    if (episodeRows.length === 0) return [];

    /**
     * One query for every episode's renders rather than one per episode: a user
     * with fifty episodes would otherwise issue fifty round trips to paint a grid.
     */
    const renderRows = await tx
      .select({
        episodeId: renders.episodeId,
        storagePath: renders.storagePath,
        durationSeconds: renders.durationSeconds,
        createdAt: renders.createdAt,
        status: renders.status,
      })
      .from(renders)
      .where(
        and(
          inArray(
            renders.episodeId,
            episodeRows.map((e) => e.episodeId),
          ),
          eq(renders.status, 'ready'),
        ),
      )
      .orderBy(desc(renders.createdAt));

    const counts = renderRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.episodeId] = (acc[r.episodeId] ?? 0) + 1;
      return acc;
    }, {});

    // Newest first above, so the first hit per episode is the latest render.
    const latest = new Map<string, (typeof renderRows)[number]>();
    for (const render of renderRows) {
      if (!latest.has(render.episodeId)) latest.set(render.episodeId, render);
    }

    return episodeRows.map((episode) => ({
      episode,
      render: latest.get(episode.episodeId) ?? null,
      renderCount: counts[episode.episodeId] ?? 0,
    }));
  });

  // One batch for the whole grid rather than a request per episode.
  const urls = await signedUrls(
    rows
      .map(({ render }) => render?.storagePath)
      .filter((path): path is string => Boolean(path)),
  );

  const withUrls = rows.map(({ episode, render, renderCount }) => ({
      ...episode,
      // Signed, short-lived, and minted per request — the buckets are private.
      downloadUrl: render?.storagePath ? (urls.get(render.storagePath) ?? null) : null,
      durationSeconds: render?.durationSeconds ?? null,
      renderedAt: render?.createdAt.toISOString() ?? null,
      renderCount,
      hasVideo: Boolean(render?.storagePath),
  }));

  return {
    episodes: withUrls,
    statuses: [...new Set(withUrls.map((e) => e.status))].sort(),
    seriesCount: new Set(withUrls.map((e) => e.seriesId)).size,
    renderedCount: withUrls.filter((e) => e.hasVideo).length,
  };
}

/** Total runtime of everything rendered, for the Library header. */
export function totalRuntimeSeconds(library: Library): number {
  return library.episodes.reduce((n, e) => n + (e.hasVideo ? (e.durationSeconds ?? 0) : 0), 0);
}
