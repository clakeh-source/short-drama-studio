import 'server-only';

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, withUserDb, type Database, type Transaction } from '@/lib/db';
import { assets, episodes, renders, scenes, series, shots } from '@/lib/db/schema';
import type { Asset, Render, Shot } from '@/lib/db/schema';
import { notFound } from '@/lib/api/handler';
import { buildTimeline, type Timeline, type TimelineWord } from '@/lib/timeline';
import { resolveCaptionStyle } from '@/lib/captions';
import { signedUrls } from '@/lib/storage';
import { getRenderProvider } from '@/lib/providers';

/**
 * Turning stored assets into a renderable timeline.
 *
 * Nothing here regenerates anything. A render reads whatever clips already
 * exist, so re-rendering after editing one shot reuses every untouched clip by
 * construction — Phase 4 AC #5. What it *does* do is refuse to render when a
 * shot has no usable clip, so the failure is "regenerate shot 7" rather than a
 * silently short episode.
 */

/**
 * Either trust level, one code path.
 *
 * A request reads through `withUserDb` so RLS applies; an Inngest job has no
 * session and reads through the privileged handle, verifying ownership against
 * the event's `userId` instead. Both expose the same query builder, so the
 * assembly logic below is written once.
 */
type Reader = Database | Transaction;

async function withReader<T>(
  userId: string,
  forJob: boolean,
  fn: (handle: Reader) => Promise<T>,
): Promise<T> {
  if (forJob) return fn(db());
  return withUserDb(userId, (tx) => fn(tx));
}

/** Newest attempt wins when a shot has been retried. */
function attemptOf(asset: Asset): number {
  return (asset.meta as { attempt?: number } | null)?.attempt ?? 0;
}

function latestAsset(rows: Asset[], shotId: string, kind: 'video' | 'voice'): Asset | null {
  const candidates = rows.filter(
    (a) => a.shotId === shotId && a.kind === kind && a.status === 'ready',
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) =>
    attemptOf(current) >= attemptOf(best) ? current : best,
  );
}

export interface RenderReadiness {
  ready: boolean;
  /** Shots with no usable clip, in playback order — what the user must fix. */
  blockingShots: Array<{ shotId: string; orderIndex: number; status: string; reason: string }>;
  shotCount: number;
  clipCount: number;
}

export interface EpisodeRenderContext {
  timeline: Timeline;
  readiness: RenderReadiness;
  captionStyleId: string;
  seriesId: string;
  episodeNumber: number;
  episodeTitle: string;
}

/**
 * Assembles the timeline for an episode.
 *
 * Playback URLs are signed, and they expire — so this is built fresh for each
 * render rather than cached. `forJob` selects the trust level: jobs run without
 * a session and verify ownership against the event's `userId`.
 */
export async function buildEpisodeTimeline(
  userId: string,
  episodeId: string,
  options: { forJob?: boolean } = {},
): Promise<EpisodeRenderContext> {
  return withReader(userId, options.forJob ?? false, async (handle) => {
    const [row] = await handle
      .select({ episode: episodes, series })
      .from(episodes)
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(eq(episodes.id, episodeId));

    if (!row) throw notFound('Episode not found');
    if (options.forJob && row.series.userId !== userId) throw notFound('Episode not found');

    const sceneRows = await handle
      .select({ id: scenes.id, orderIndex: scenes.orderIndex })
      .from(scenes)
      .where(eq(scenes.episodeId, episodeId))
      .orderBy(asc(scenes.orderIndex));

    let shotRows: Shot[] = [];
    let assetRows: Asset[] = [];

    if (sceneRows.length > 0) {
      shotRows = await handle
        .select()
        .from(shots)
        .where(
          inArray(
            shots.sceneId,
            sceneRows.map((s) => s.id),
          ),
        );
      assetRows = await handle.select().from(assets).where(eq(assets.episodeId, episodeId));
    }

    // Playback order: by scene, then by position within the scene.
    const sceneOrder = new Map(sceneRows.map((s) => [s.id, s.orderIndex]));
    const ordered = [...shotRows].sort(
      (a, b) =>
        (sceneOrder.get(a.sceneId) ?? 0) - (sceneOrder.get(b.sceneId) ?? 0) ||
        a.orderIndex - b.orderIndex,
    );

    const blockingShots: RenderReadiness['blockingShots'] = [];

    /**
     * Every playback URL the timeline needs, signed in one batch.
     *
     * `createSignedUrl` is one HTTP request per object, so this loop used to make
     * two round trips per shot — forty for a twenty-shot episode — every time the
     * export panel loaded or a render was queued.
     */
    const urls = await signedUrls([
      ...ordered.flatMap((shot) =>
        [
          latestAsset(assetRows, shot.id, 'video')?.storagePath,
          latestAsset(assetRows, shot.id, 'voice')?.storagePath,
        ].filter((path): path is string => Boolean(path)),
      ),
      ...(row.series.musicStoragePath ? [row.series.musicStoragePath] : []),
    ]);

    const shotInputs = await Promise.all(
      ordered.map(async (shot, index) => {
        const video = latestAsset(assetRows, shot.id, 'video');
        const voice = latestAsset(assetRows, shot.id, 'voice');

        if (!video?.storagePath) {
          blockingShots.push({
            shotId: shot.id,
            orderIndex: index,
            status: shot.status,
            reason:
              shot.status === 'failed'
                ? 'Its clip failed to generate.'
                : shot.status === 'ready'
                  ? 'Its clip is missing from storage.'
                  : 'It has no clip yet.',
          });
        }

        const videoUrl = video?.storagePath ? (urls.get(video.storagePath) ?? null) : null;
        const voiceUrl = voice?.storagePath ? (urls.get(voice.storagePath) ?? null) : null;

        const meta = voice?.meta as { measuredSeconds?: number; words?: TimelineWord[] } | null;

        return {
          shotId: shot.id,
          durationSeconds: shot.durationSeconds,
          videoUrl,
          dialogue: shot.dialogue,
          voiceUrl,
          voiceDurationSeconds: meta?.measuredSeconds ?? voice?.durationSeconds ?? null,
          ...(meta?.words?.length ? { words: meta.words } : {}),
        };
      }),
    );

    const musicUrl = row.series.musicStoragePath
      ? (urls.get(row.series.musicStoragePath) ?? null)
      : null;

    const style = resolveCaptionStyle(row.series.captionStyleId);

    const timeline = buildTimeline({
      shots: shotInputs,
      musicUrl,
      // Wider frames fit more characters, but a phone still wants short cues.
      maxCaptionChars: style.fontSizePx >= 62 ? 24 : 30,
    });

    return {
      timeline,
      readiness: {
        ready: blockingShots.length === 0 && timeline.clips.length > 0,
        blockingShots: blockingShots.sort((a, b) => a.orderIndex - b.orderIndex),
        shotCount: ordered.length,
        clipCount: timeline.clips.length,
      },
      captionStyleId: style.id,
      seriesId: row.series.id,
      episodeNumber: row.episode.number,
      episodeTitle: row.episode.title,
    };
  });
}

/**
 * Everything the export panel needs, in one place.
 *
 * The server page and the polling route both feed the same component, and each
 * used to assemble this shape by hand — so adding the render estimate meant
 * adding it twice, and any field added to one would silently be missing from the
 * other. One builder, one shape.
 */
export async function buildRendersPayload(userId: string, episodeId: string) {
  const [rows, built] = await Promise.all([
    listRenders(userId, episodeId),
    buildEpisodeTimeline(userId, episodeId),
  ]);

  const renderUrls = await signedUrls(
    rows.map((row) => row.storagePath).filter((path): path is string => Boolean(path)),
  );

  const renderRows = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      error: row.error,
      costCents: row.costCents,
      durationSeconds: row.durationSeconds,
      createdAt: row.createdAt.toISOString(),
      downloadUrl: row.storagePath ? (renderUrls.get(row.storagePath) ?? null) : null,
      meta: row.meta,
    })),
  );

  const provider = getRenderProvider();

  return {
    renders: renderRows,
    readiness: built.readiness,
    provider: provider.id,
    /**
     * Priced here, before the click. Nothing in this app spends money without
     * showing the number first, and the render route only reports its estimate
     * once the job is already queued.
     */
    estimateCents: provider.estimateCostCents({
      clips: built.timeline.clips,
      voiceTracks: built.timeline.voiceTracks,
      captions: built.timeline.captions,
      aspectRatio: built.timeline.aspectRatio,
      resolution: built.timeline.resolution,
      ...(built.timeline.musicUrl ? { musicUrl: built.timeline.musicUrl } : {}),
    }),
    timeline: {
      totalSeconds: built.timeline.totalSeconds,
      clipCount: built.timeline.clips.length,
      voiceCount: built.timeline.voiceTracks.length,
      captionCount: built.timeline.captions.length,
      resolution: built.timeline.resolution,
      hasMusic: Boolean(built.timeline.musicUrl),
      // Enough to drive the per-shot scrubber in the preview player.
      clips: built.timeline.clips.map((c) => ({
        shotId: c.shotId,
        startAt: c.startAt,
        durationSeconds: c.durationSeconds,
      })),
    },
    active: renderRows.some((r) => r.status === 'queued' || r.status === 'generating'),
  };
}

/* -------------------------------------------------------------------------- */
/* Render rows                                                                */
/* -------------------------------------------------------------------------- */

export async function listRenders(userId: string, episodeId: string): Promise<Render[]> {
  return withUserDb(userId, (tx) =>
    tx.select().from(renders).where(eq(renders.episodeId, episodeId)).orderBy(desc(renders.createdAt)),
  );
}

export async function latestRender(userId: string, episodeId: string): Promise<Render | null> {
  const rows = await listRenders(userId, episodeId);
  return rows[0] ?? null;
}

/** Job-side: create the row that tracks one render attempt. */
export async function createRenderRow(input: {
  episodeId: string;
  provider: string;
}): Promise<Render> {
  const [row] = await db()
    .insert(renders)
    .values({
      episodeId: input.episodeId,
      provider: input.provider,
      status: 'queued',
      costCents: 0,
      // Cross-cutting disclosure requirement: stamped on every render row.
      meta: { ai_generated: true },
    })
    .returning();
  return row!;
}

export async function updateRenderRow(
  renderId: string,
  patch: Partial<{
    providerJobId: string | null;
    storagePath: string | null;
    durationSeconds: number | null;
    costCents: number;
    status: 'pending' | 'queued' | 'generating' | 'ready' | 'failed';
    error: string | null;
    meta: Record<string, unknown>;
  }>,
): Promise<Render | null> {
  const [row] = await db().update(renders).set(patch).where(eq(renders.id, renderId)).returning();
  return row ?? null;
}

/** The in-flight render for an episode, if there is one. */
export async function activeRender(episodeId: string): Promise<Render | null> {
  const [row] = await db()
    .select()
    .from(renders)
    .where(
      and(
        eq(renders.episodeId, episodeId),
        inArray(renders.status, ['queued', 'generating']),
      ),
    )
    .orderBy(desc(renders.createdAt));
  return row ?? null;
}
