import 'server-only';

import { asc, eq, inArray } from 'drizzle-orm';
import { withUserDb } from '@/lib/db';
import { assets, episodes, scenes, series, shots } from '@/lib/db/schema';
import type { Asset } from '@/lib/db/schema';
import { KEEP_SHOT_VERSIONS } from '@/lib/data/generation';
import { notFound } from '@/lib/api/handler';
import { signedUrls } from '@/lib/storage';

/**
 * The review board: one series, every episode, every scene, every shot.
 *
 * Built as a single tree rather than a page per level because the thing a
 * reviewer actually does is scan for what is wrong — a shot that failed, a scene
 * that is still generating — and that is a whole-project question. Drilling into
 * four pages to find it would be the wrong shape for the task.
 *
 * One query per table and one batched signing call for the whole tree. The
 * status endpoint rebuilds this on a five-second poll, so per-shot round trips
 * would be paid for over and over.
 */

export interface ReviewVersion {
  version: number;
  assetId: string;
  status: string;
  url: string | null;
  costCents: number;
  error: string | null;
  createdAt: string;
  /** True for the take the shot is currently pointing at. */
  active: boolean;
}

export interface ReviewShot {
  id: string;
  orderIndex: number;
  status: string;
  camera: string;
  action: string;
  dialogue: string | null;
  durationSeconds: number;
  version: number;
  retryCount: number;
  /** The prompt actually sent, override included. Editable in the detail view. */
  videoPrompt: string | null;
  promptOverride: string | null;
  /** Playback URL for the active take, or null until one exists. */
  videoUrl: string | null;
  error: string | null;
  /** Newest first, capped at what the pruner keeps. */
  versions: ReviewVersion[];
}

export interface ReviewScene {
  id: string;
  orderIndex: number;
  location: string;
  timeOfDay: string;
  summary: string;
  shots: ReviewShot[];
}

export interface ReviewEpisode {
  id: string;
  number: number;
  title: string;
  status: string;
  outputUrl: string | null;
  durationSeconds: number | null;
  scenes: ReviewScene[];
  /** Everything the Assemble button needs to explain itself. */
  assembly: {
    ready: boolean;
    shotCount: number;
    readyShotCount: number;
    /** Why it is disabled, shot by shot. Empty when it is not. */
    blocking: Array<{ shotId: string; sceneIndex: number; shotIndex: number; reason: string }>;
  };
}

export interface ReviewTree {
  seriesId: string;
  title: string;
  status: string;
  episodes: ReviewEpisode[];
  /** True while anything is moving, so the client can stop polling. */
  active: boolean;
}

/**
 * One entry per take, newest first, capped at what the pruner keeps.
 *
 * Collapsed to the newest attempt within each take: a retry that failed before
 * a later one succeeded is not a version anyone would want to revert to, and
 * showing it in the history strip would make three takes look like six.
 */
function versionsFor(rows: Asset[]): Asset[] {
  return rows
    .filter((a) => a.kind === 'video')
    .sort((a, b) => b.version - a.version || attemptOf(b) - attemptOf(a))
    .filter((asset, index, all) => all.findIndex((a) => a.version === asset.version) === index)
    .slice(0, KEEP_SHOT_VERSIONS);
}

function attemptOf(asset: Asset): number {
  return (asset.meta as { attempt?: number } | null)?.attempt ?? 0;
}

export async function loadReviewTree(userId: string, seriesId: string): Promise<ReviewTree> {
  const raw = await withUserDb(userId, async (tx) => {
    const [seriesRow] = await tx.select().from(series).where(eq(series.id, seriesId));
    if (!seriesRow) throw notFound('Series not found');

    const episodeRows = await tx
      .select()
      .from(episodes)
      .where(eq(episodes.seriesId, seriesId))
      .orderBy(asc(episodes.number));

    if (episodeRows.length === 0) {
      return { seriesRow, episodeRows, sceneRows: [], shotRows: [], assetRows: [] };
    }

    const episodeIds = episodeRows.map((e) => e.id);

    const sceneRows = await tx
      .select()
      .from(scenes)
      .where(inArray(scenes.episodeId, episodeIds))
      .orderBy(asc(scenes.orderIndex));

    if (sceneRows.length === 0) {
      return { seriesRow, episodeRows, sceneRows, shotRows: [], assetRows: [] };
    }

    const shotRows = await tx
      .select()
      .from(shots)
      .where(
        inArray(
          shots.sceneId,
          sceneRows.map((s) => s.id),
        ),
      )
      .orderBy(asc(shots.orderIndex));

    const assetRows = await tx
      .select()
      .from(assets)
      .where(inArray(assets.episodeId, episodeIds));

    return { seriesRow, episodeRows, sceneRows, shotRows, assetRows };
  });

  // Everything playable in the whole tree, signed in one request per bucket.
  const urls = await signedUrls([
    ...raw.assetRows
      .filter((a) => a.kind === 'video' && a.storagePath)
      .map((a) => a.storagePath!),
    ...raw.episodeRows
      .filter((e) => e.outputStoragePath)
      .map((e) => e.outputStoragePath!),
  ]);

  let active = false;

  const episodeList: ReviewEpisode[] = raw.episodeRows.map((episode) => {
    const episodeScenes = raw.sceneRows.filter((s) => s.episodeId === episode.id);

    const blocking: ReviewEpisode['assembly']['blocking'] = [];
    let shotCount = 0;
    let readyShotCount = 0;

    const sceneList: ReviewScene[] = episodeScenes.map((scene, sceneIndex) => {
      const owned = raw.shotRows.filter((s) => s.sceneId === scene.id);

      const shotList: ReviewShot[] = owned.map((shot, shotIndex) => {
        const shotAssets = raw.assetRows.filter((a) => a.shotId === shot.id);
        const takes = versionsFor(shotAssets);

        const activeTake = takes.find((t) => t.version === shot.version) ?? null;
        const videoUrl = activeTake?.storagePath
          ? (urls.get(activeTake.storagePath) ?? null)
          : null;

        shotCount += 1;
        if (shot.status === 'ready' && videoUrl) readyShotCount += 1;
        else {
          blocking.push({
            shotId: shot.id,
            sceneIndex,
            shotIndex,
            reason:
              shot.status === 'failed'
                ? 'Its clip failed to generate.'
                : shot.status === 'generating' || shot.status === 'queued'
                  ? 'It is still generating.'
                  : shot.status === 'ready'
                    ? 'Its clip is missing from storage.'
                    : 'It has not been generated yet.',
          });
        }

        if (shot.status === 'queued' || shot.status === 'generating') active = true;

        return {
          id: shot.id,
          orderIndex: shot.orderIndex,
          status: shot.status,
          camera: shot.camera,
          action: shot.action,
          dialogue: shot.dialogue,
          durationSeconds: shot.durationSeconds,
          version: shot.version,
          retryCount: shot.retryCount,
          videoPrompt: shot.videoPrompt,
          promptOverride: shot.promptOverride,
          videoUrl,
          error: activeTake?.error ?? null,
          versions: takes.map((take) => ({
            version: take.version,
            assetId: take.id,
            status: take.status,
            url: take.storagePath ? (urls.get(take.storagePath) ?? null) : null,
            costCents: take.costCents,
            error: take.error,
            createdAt: take.createdAt.toISOString(),
            active: take.version === shot.version,
          })),
        };
      });

      return {
        id: scene.id,
        orderIndex: scene.orderIndex,
        location: scene.location,
        timeOfDay: scene.timeOfDay,
        summary: scene.summary,
        shots: shotList,
      };
    });

    return {
      id: episode.id,
      number: episode.number,
      title: episode.title,
      status: episode.status,
      outputUrl: episode.outputStoragePath
        ? (urls.get(episode.outputStoragePath) ?? null)
        : null,
      durationSeconds: episode.durationSeconds,
      scenes: sceneList,
      assembly: {
        // An episode with no shots is not "ready", it is empty. Without this an
        // empty episode offers an enabled Assemble button that 409s on click.
        ready: shotCount > 0 && blocking.length === 0,
        shotCount,
        readyShotCount,
        blocking,
      },
    };
  });

  return {
    seriesId: raw.seriesRow.id,
    title: raw.seriesRow.title,
    status: raw.seriesRow.status,
    episodes: episodeList,
    active,
  };
}
