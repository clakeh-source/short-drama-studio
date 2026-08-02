import 'server-only';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, withUserDb } from '@/lib/db';
import { assets, characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import type { Asset, Character, Episode, Series, Shot } from '@/lib/db/schema';
import { notFound } from '@/lib/api/handler';
import { deleteObjects, signedUrls } from '@/lib/storage';
import { voiceOverruns } from '@/lib/shots';
import { log } from '@/lib/log';

/**
 * Reads and writes for the generation pipeline.
 *
 * Inngest functions run with no user session, so they use the privileged handle
 * (`db()`) and scope by the `userId` carried on the event. Anything reached from
 * a request still goes through `withUserDb` so RLS applies. The two are kept in
 * separate functions rather than one with a flag, so it is always obvious from
 * the call site which trust level is in play.
 */

export interface ShotContext {
  shot: Shot;
  scene: { id: string; location: string; timeOfDay: string; orderIndex: number };
  episode: Episode;
  series: Series;
  speaker: Character | null;
}

/** Job-side load: privileged, verified against the event's `userId`. */
export async function loadShotForJob(shotId: string, userId: string): Promise<ShotContext> {
  const handle = db();

  const [row] = await handle
    .select({
      shot: shots,
      scene: {
        id: scenes.id,
        location: scenes.location,
        timeOfDay: scenes.timeOfDay,
        orderIndex: scenes.orderIndex,
      },
      episode: episodes,
      series,
    })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(eq(shots.id, shotId));

  if (!row) throw notFound('Shot not found');

  // The event says who owns this; the database is the arbiter.
  if (row.series.userId !== userId) {
    throw notFound('Shot not found');
  }

  const speaker = row.shot.speakerCharacterId
    ? ((
        await handle
          .select()
          .from(characters)
          .where(eq(characters.id, row.shot.speakerCharacterId))
      )[0] ?? null)
    : null;

  return { ...row, speaker };
}

/** Every shot in an episode, in playback order. */
export async function loadEpisodeShotsForJob(
  episodeId: string,
  userId: string,
): Promise<{ episode: Episode; series: Series; shots: Shot[] }> {
  const handle = db();

  const [row] = await handle
    .select({ episode: episodes, series })
    .from(episodes)
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(eq(episodes.id, episodeId));

  if (!row || row.series.userId !== userId) throw notFound('Episode not found');

  const sceneRows = await handle
    .select({ id: scenes.id })
    .from(scenes)
    .where(eq(scenes.episodeId, episodeId))
    .orderBy(asc(scenes.orderIndex));

  if (sceneRows.length === 0) return { ...row, shots: [] };

  const shotRows = await handle
    .select()
    .from(shots)
    .where(
      inArray(
        shots.sceneId,
        sceneRows.map((s) => s.id),
      ),
    )
    .orderBy(asc(shots.sceneId), asc(shots.orderIndex));

  // Order by scene, then by position within the scene.
  const sceneOrder = new Map(sceneRows.map((s, i) => [s.id, i]));
  shotRows.sort(
    (a, b) =>
      (sceneOrder.get(a.sceneId) ?? 0) - (sceneOrder.get(b.sceneId) ?? 0) ||
      a.orderIndex - b.orderIndex,
  );

  return { ...row, shots: shotRows };
}

/* -------------------------------------------------------------------------- */
/* Shot status                                                                */
/* -------------------------------------------------------------------------- */

export type ShotStatus = 'pending' | 'queued' | 'generating' | 'ready' | 'failed';

export async function setShotStatus(
  shotId: string,
  status: ShotStatus,
  extra?: { retryCount?: number },
): Promise<void> {
  await db()
    .update(shots)
    .set({ status, ...(extra?.retryCount !== undefined ? { retryCount: extra.retryCount } : {}) })
    .where(eq(shots.id, shotId));
}

/** What a shot needs before it can honestly be called ready. */
export function requiredAssetKinds(shot: Pick<Shot, 'dialogue'>): Array<'video' | 'voice'> {
  return shot.dialogue?.trim() ? ['video', 'voice'] : ['video'];
}

/**
 * Derives a shot's status from its assets, rather than from whichever sibling
 * job happened to finish last.
 *
 * The video and voice jobs are independent fan-out siblings; neither waits on
 * the other. While the video job alone owned the transition to `ready`, an
 * episode whose every voice job had failed still showed a fully green board and
 * an enabled Render button — inviting the reviewer to export a silent film. That
 * defeats the whole point of the review gate, which is that the human sees the
 * true state before any spend. Readiness has to mean "every asset this shot
 * needs is present".
 *
 * Attempts are collapsed per kind: a later successful retry supersedes an
 * earlier failure, so a kind counts as ready if *any* of its attempts is ready.
 */
export async function reconcileShotStatus(shotId: string): Promise<ShotStatus> {
  const handle = db();

  const [shot] = await handle.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) throw notFound('Shot not found');

  // Only the current take. A shot that has been regenerated still owns its
  // previous versions' rows, and an old `ready` video would otherwise report the
  // shot finished while the new take was still generating.
  const rows = await handle
    .select({ kind: assets.kind, status: assets.status })
    .from(assets)
    .where(and(eq(assets.shotId, shotId), eq(assets.version, shot.version)));

  const needed = requiredAssetKinds(shot);
  const statuses = needed.map((kind) => {
    const forKind = rows.filter((r) => r.kind === kind);
    if (forKind.some((r) => r.status === 'ready')) return 'ready';
    if (forKind.length > 0 && forKind.every((r) => r.status === 'failed')) return 'failed';
    return 'pending';
  });

  const next: ShotStatus = statuses.every((s) => s === 'ready')
    ? 'ready'
    : statuses.includes('failed')
      ? 'failed'
      : 'generating';

  await setShotStatus(shotId, next);
  await settleEpisodeAfterGeneration(shot.sceneId);
  return next;
}

/**
 * Moves an episode off `generating` once every shot has settled.
 *
 * The fan-out sets `generating`, but only the *render* ever moved it on, so a
 * successfully generated episode sat at `generating` indefinitely and the export
 * panel reported work still in progress next to twenty finished shots.
 *
 * It goes back to `storyboarded` rather than to a new state: the enum has no
 * "generated", and `storyboarded` is already what the render-failure path uses to
 * mean "the shots are good, this is ready to assemble". Only `generating` is
 * touched, so a `rendered` episode is never walked backwards.
 */
async function settleEpisodeAfterGeneration(sceneId: string | null): Promise<void> {
  if (!sceneId) return;
  const handle = db();

  const [scene] = await handle
    .select({ episodeId: scenes.episodeId })
    .from(scenes)
    .where(eq(scenes.id, sceneId));
  if (!scene) return;

  const siblings = await handle
    .select({ status: shots.status })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .where(eq(scenes.episodeId, scene.episodeId));

  const settled = siblings.every((s) => s.status === 'ready' || s.status === 'failed');
  if (!settled) return;

  await handle
    .update(episodes)
    .set({ status: siblings.some((s) => s.status === 'failed') ? 'failed' : 'storyboarded' })
    .where(and(eq(episodes.id, scene.episodeId), eq(episodes.status, 'generating')));
}

/**
 * The provider job already recorded for an asset, if any.
 *
 * Read fresh inside the submit step rather than carried from an earlier step: a
 * step's memoised result is whatever it returned the *first* time, which for the
 * asset row was before any job existed.
 *
 * This is what keeps a retried submit from paying twice. Now that Inngest is
 * allowed to retry step execution (it must be, or a restart strands the
 * episode), a `submit` that threw after the provider had accepted the job would
 * otherwise be re-run and charged again.
 */
export async function recordedProviderJobId(
  assetId: string,
): Promise<{ providerJobId: string; meta: Record<string, unknown> } | null> {
  const [row] = await db()
    .select({ providerJobId: assets.providerJobId, meta: assets.meta })
    .from(assets)
    .where(eq(assets.id, assetId));

  if (!row?.providerJobId) return null;

  // The meta comes back with the id because it was written in the same step:
  // a resumed job that adopted a submission but forgot what that submission
  // carried would overwrite the record with silence when the clip lands.
  return {
    providerJobId: row.providerJobId,
    meta: (row.meta as Record<string, unknown> | null) ?? {},
  };
}

/* -------------------------------------------------------------------------- */
/* Admission control                                                          */
/* -------------------------------------------------------------------------- */

/** Phase 3 AC #4: at most this many video jobs live at the provider per user. */
/**
 * In-flight video jobs per project.
 *
 * Three is the spec's, and it is the right default: it bounds cost and keeps
 * well inside a provider's rate limits. It is also the single biggest lever on
 * how long a run takes, and for a multi-minute film that matters — 36 clips at
 * three at a time is a 24-minute wait, at eight it is nine minutes. Raise it if
 * your provider tolerates it; the arithmetic is linear and the wall-clock
 * estimate in lib/runs/estimate.ts follows this number.
 *
 * Read once at module load, because the Inngest function's `concurrency` option
 * is evaluated when the function is defined and the two must not disagree.
 */
export const MAX_INFLIGHT_VIDEO_JOBS = (() => {
  const raw = Number(process.env.VIDEO_CONCURRENCY);
  // A cap of zero would wedge every project permanently, so nonsense falls back
  // rather than being honoured.
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.min(Math.floor(raw), 24);
})();

/**
 * How long a claimed slot is honoured before it is treated as abandoned.
 *
 * A process that dies between claiming a slot and recording a terminal status
 * would otherwise hold it forever, and three such deaths would wedge the
 * project permanently. The lease is generous relative to a real video job (a
 * couple of minutes) so a slow provider is never mistaken for a dead worker.
 */
export const VIDEO_SLOT_LEASE_MINUTES = 20;

/**
 * Claims one of the *project's* in-flight video slots for `assetId`, returning
 * whether it succeeded.
 *
 * Scoped to the series, not the user: the cap exists to bound cost and rate
 * limits per project, so someone with two shows in flight gets three slots each.
 *
 * Inngest's `concurrency` option bounds *step execution*, not provider work: the
 * poll loop hands its slot back on every `step.sleep`, so an episode fanned out
 * to 20 shots submitted all 20 to the provider before any of them finished — a
 * measured peak of 20 live jobs against a stated limit of 3. The declared
 * concurrency key is still there and still useful, but the bound that actually
 * holds has to be counted where the work is, which is the assets table. A queue
 * whose workers block on polling would not need this; Inngest's do not block,
 * and that is the whole difference.
 *
 * The count and the claim are one statement under a per-project advisory lock,
 * so two runs cannot both observe two in flight and both proceed to a third.
 */
export async function claimVideoSlot(seriesId: string, assetId: string): Promise<boolean> {
  return db().transaction(async (tx) => {
    // Serialises claims for this project only. Released when the transaction ends.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${seriesId}))`);

    const rows = await tx.execute<{ inflight: number }>(sql`
      select count(*)::int as inflight
        from assets a
        join episodes e on e.id = a.episode_id
       where e.series_id = ${seriesId}::uuid
         and a.kind = 'video'
         and a.status = 'generating'
         and a.id <> ${assetId}::uuid
         and a.updated_at > now() - ${`${VIDEO_SLOT_LEASE_MINUTES} minutes`}::interval
    `);

    // No row would mean the count query itself failed to return; refuse the
    // claim rather than assume the queue is empty.
    const inflight = rows[0]?.inflight ?? MAX_INFLIGHT_VIDEO_JOBS;
    if (inflight >= MAX_INFLIGHT_VIDEO_JOBS) return false;

    // Taking the slot *is* moving to `generating`; the submit step follows.
    await tx
      .update(assets)
      .set({ status: 'generating' })
      .where(eq(assets.id, assetId));

    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                     */
/* -------------------------------------------------------------------------- */

export type AssetKind = 'video' | 'image' | 'voice' | 'music' | 'sfx';

/**
 * Finds or creates the asset row for this shot/kind/attempt.
 *
 * Idempotent by design: Inngest may re-execute a step after a crash, and a
 * second `INSERT` would leave an orphan row that inflates the cost total. The
 * attempt number is part of the identity, so a genuine retry gets its own row
 * and both are visible in the usage history.
 */
export async function upsertAsset(input: {
  shotId: string;
  episodeId: string;
  kind: AssetKind;
  provider: string;
  attempt: number;
  /** The take this belongs to. Defaults to 1 for callers with no versioning. */
  version?: number;
}): Promise<Asset> {
  const handle = db();
  const version = input.version ?? 1;

  const [existing] = await handle
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.shotId, input.shotId),
        eq(assets.kind, input.kind),
        eq(assets.version, version),
        sql`coalesce((${assets.meta} ->> 'attempt')::int, 0) = ${input.attempt}`,
      ),
    );

  if (existing) return existing;

  const [created] = await handle
    .insert(assets)
    .values({
      shotId: input.shotId,
      episodeId: input.episodeId,
      kind: input.kind,
      provider: input.provider,
      version,
      status: 'queued',
      costCents: 0,
      meta: { attempt: input.attempt, version, ai_generated: true },
    })
    .returning();

  return created!;
}

/* -------------------------------------------------------------------------- */
/* Version history                                                            */
/* -------------------------------------------------------------------------- */

/** How many takes of a shot survive. Older ones are deleted, storage included. */
export const KEEP_SHOT_VERSIONS = 3;

/**
 * Deletes every take of a shot beyond the most recent `KEEP_SHOT_VERSIONS`.
 *
 * Storage first, then the rows — the same ordering as everywhere else that owns
 * both. A row pointing at a deleted object shows up as a broken thumbnail and
 * can be cleaned up again; an object with no row pointing at it is an invisible
 * bill nobody will ever look for.
 *
 * Run after a regeneration rather than on a schedule, because the moment a
 * fourth take exists is exactly the moment the first one stopped mattering.
 */
export async function pruneShotVersions(
  shotId: string,
  keep: number = KEEP_SHOT_VERSIONS,
): Promise<{ prunedVersions: number[]; deletedObjects: number }> {
  const handle = db();

  const rows = await handle.select().from(assets).where(eq(assets.shotId, shotId));

  const versions = [...new Set(rows.map((r) => r.version))].sort((a, b) => b - a);
  const doomed = versions.slice(keep);

  if (doomed.length === 0) return { prunedVersions: [], deletedObjects: 0 };

  /**
   * A pinned asset is never pruned.
   *
   * Pruning is a rule about *takes* — the fourth regeneration makes the first
   * one uninteresting. A pinned start frame is not a take: someone chose it,
   * and it is the input to future takes rather than the output of an old one.
   * Deleting it by version count would remove the image the next generation is
   * supposed to start from, and the shot would quietly go back to drawing its
   * own keyframe.
   */
  const condemned = rows.filter(
    (r) => doomed.includes(r.version) && (r.meta as { pinned?: boolean } | null)?.pinned !== true,
  );
  const paths = condemned
    .map((r) => r.storagePath)
    .filter((p): p is string => Boolean(p));

  if (paths.length > 0) await deleteObjects(paths);

  await handle.delete(assets).where(
    inArray(
      assets.id,
      condemned.map((r) => r.id),
    ),
  );

  log.info('pruned old shot versions', {
    shotId,
    operation: 'shot.versions.prune',
    prunedVersions: doomed,
    deletedObjects: paths.length,
  });

  return { prunedVersions: doomed, deletedObjects: paths.length };
}

/** Every surviving take of a shot, newest first. What the UI's history strip shows. */
export async function loadShotVersions(shotId: string): Promise<Asset[]> {
  const rows = await db()
    .select()
    .from(assets)
    .where(and(eq(assets.shotId, shotId), eq(assets.kind, 'video')));

  return rows.sort(
    (a, b) =>
      b.version - a.version ||
      ((b.meta as { attempt?: number } | null)?.attempt ?? 0) -
        ((a.meta as { attempt?: number } | null)?.attempt ?? 0),
  );
}

export async function updateAsset(
  assetId: string,
  patch: Partial<{
    providerJobId: string | null;
    storagePath: string | null;
    durationSeconds: number | null;
    costCents: number;
    status: 'pending' | 'queued' | 'generating' | 'ready' | 'failed';
    error: string | null;
    meta: Record<string, unknown>;
  }>,
): Promise<Asset | null> {
  const [row] = await db().update(assets).set(patch).where(eq(assets.id, assetId)).returning();
  return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* Request-side reads                                                         */
/* -------------------------------------------------------------------------- */

export interface ShotProgress {
  shotId: string;
  sceneId: string;
  orderIndex: number;
  durationSeconds: number;
  status: string;
  retryCount: number;
  dialogue: string | null;
  video: {
    assetId: string;
    status: string;
    storagePath: string | null;
    costCents: number;
    error: string | null;
  } | null;
  voice: {
    assetId: string;
    status: string;
    storagePath: string | null;
    durationSeconds: number | null;
    costCents: number;
    error: string | null;
  } | null;
}

/**
 * Everything the generation UI polls for. Read through RLS — this is a request,
 * not a job.
 */
/**
 * The generation board's state: every shot, its assets, signed playback URLs and
 * the voice-overrun flags.
 *
 * One builder because two callers need the identical shape — the server page for
 * its first paint and `/api/episodes/[id]/status` for every poll after that. They
 * each assembled it by hand, which is how `buildRendersPayload` came to be missing
 * a field on one side, and both reimplemented the overrun comparison inline
 * instead of using `voiceOverruns`.
 *
 * Signing is batched — see `signedUrls` for what that is and is not worth. It
 * matters most here because this shape is rebuilt on every three-second poll for
 * as long as generation runs.
 */
export async function buildEpisodeStatus(userId: string, episodeId: string) {
  const progress = await loadEpisodeProgress(userId, episodeId);

  const urls = await signedUrls(
    progress.shots.flatMap((shot) =>
      [shot.video?.storagePath, shot.voice?.storagePath].filter(
        (path): path is string => Boolean(path),
      ),
    ),
  );

  const shots = progress.shots.map((shot) => {
    const voiceSeconds = shot.voice?.durationSeconds ?? null;
    const overruns = voiceSeconds !== null && voiceOverruns(voiceSeconds, shot.durationSeconds);

    return {
      ...shot,
      videoUrl: shot.video?.storagePath ? (urls.get(shot.video.storagePath) ?? null) : null,
      voiceUrl: shot.voice?.storagePath ? (urls.get(shot.voice.storagePath) ?? null) : null,
      voiceOverruns: overruns,
      /** What the shot would need to be to fit the line comfortably. */
      suggestedDurationSeconds: overruns && voiceSeconds ? Math.ceil(voiceSeconds + 1) : null,
    };
  });

  return {
    episodeStatus: progress.episodeStatus,
    shots,
    counts: shots.reduce<Record<string, number>>((acc, shot) => {
      acc[shot.status] = (acc[shot.status] ?? 0) + 1;
      return acc;
    }, {}),
    /** True while anything is still moving, so the client can stop polling. */
    active: shots.some((s) => s.status === 'queued' || s.status === 'generating'),
    totalCostCents: shots.reduce(
      (n, s) => n + (s.video?.costCents ?? 0) + (s.voice?.costCents ?? 0),
      0,
    ),
  };
}

export async function loadEpisodeProgress(
  userId: string,
  episodeId: string,
): Promise<{ shots: ShotProgress[]; episodeStatus: string }> {
  return withUserDb(userId, async (tx) => {
    const [episode] = await tx.select().from(episodes).where(eq(episodes.id, episodeId));
    if (!episode) throw notFound('Episode not found');

    const sceneRows = await tx
      .select({ id: scenes.id, orderIndex: scenes.orderIndex })
      .from(scenes)
      .where(eq(scenes.episodeId, episodeId))
      .orderBy(asc(scenes.orderIndex));

    if (sceneRows.length === 0) return { shots: [], episodeStatus: episode.status };

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

    const assetRows = await tx.select().from(assets).where(eq(assets.episodeId, episodeId));

    const attemptOf = (asset: Asset): number =>
      (asset.meta as { attempt?: number } | null)?.attempt ?? 0;

    /**
     * Newest take wins, and within a take, the newest attempt.
     *
     * Version first: a regeneration produces a strictly newer take, and it is
     * the one the board should show even before its clip has landed. Attempt
     * only breaks ties inside one take.
     */
    const latest = (shotId: string, kind: AssetKind): Asset | null => {
      const candidates = assetRows.filter((a) => a.shotId === shotId && a.kind === kind);
      if (candidates.length === 0) return null;
      return candidates.reduce((best, current) =>
        current.version > best.version ||
        (current.version === best.version && attemptOf(current) >= attemptOf(best))
          ? current
          : best,
      );
    };

    const sceneOrder = new Map(sceneRows.map((s) => [s.id, s.orderIndex]));
    const ordered = [...shotRows].sort(
      (a, b) =>
        (sceneOrder.get(a.sceneId) ?? 0) - (sceneOrder.get(b.sceneId) ?? 0) ||
        a.orderIndex - b.orderIndex,
    );

    return {
      episodeStatus: episode.status,
      shots: ordered.map((shot): ShotProgress => {
        const video = latest(shot.id, 'video');
        const voice = latest(shot.id, 'voice');

        return {
          shotId: shot.id,
          sceneId: shot.sceneId,
          orderIndex: shot.orderIndex,
          durationSeconds: shot.durationSeconds,
          status: shot.status,
          retryCount: shot.retryCount,
          dialogue: shot.dialogue,
          video: video
            ? {
                assetId: video.id,
                status: video.status,
                storagePath: video.storagePath,
                costCents: video.costCents,
                error: video.error,
              }
            : null,
          voice: voice
            ? {
                assetId: voice.id,
                status: voice.status,
                storagePath: voice.storagePath,
                durationSeconds: voice.durationSeconds,
                costCents: voice.costCents,
                error: voice.error,
              }
            : null,
        };
      }),
    };
  });
}
