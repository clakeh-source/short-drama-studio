import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, withUserDb } from '@/lib/db';
import { assets, runs, scenes, shots, usageLog } from '@/lib/db/schema';
import type { Run, RunStage, RunStatus } from '@/lib/db/schema';
import { notFound } from '@/lib/api/handler';

/**
 * Reads and writes for unattended runs.
 *
 * The supervisor runs with no user session, so it uses the privileged handle and
 * scopes by the `userId` on the run row; anything reached from a request goes
 * through `withUserDb` so RLS applies. Same split as the rest of the pipeline.
 */

/**
 * Stages that pause for a look before continuing.
 *
 * The two places where being wrong is expensive and invisible until much later.
 * A wrong bible means the whole cast and every scene is about the wrong show; a
 * wrong shot list means thirty clips of the wrong coverage. Everything after
 * these is mechanical, and everything before them is cheap.
 */
export const GATED_STAGES: readonly RunStage[] = ['bible', 'storyboard'];

/**
 * How long a gate waits before continuing on its own.
 *
 * Long enough to read a bible and stop it; short enough that walking away still
 * gets you a film, which is the entire premise of "auto with skippable gates".
 */
export const DEFAULT_GATE_SECONDS = 120;

export function gateSeconds(): number {
  const raw = Number(process.env.RUN_GATE_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GATE_SECONDS;
}

export function isGated(stage: RunStage): boolean {
  return GATED_STAGES.includes(stage);
}

/** The order stages run in. `done` is a terminal marker, not a stage of work. */
export const STAGE_ORDER: readonly RunStage[] = [
  'bible',
  'cast',
  'script',
  'storyboard',
  'shots',
  'assemble',
  'done',
];

export function nextStage(stage: RunStage): RunStage {
  const index = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER[index + 1] ?? 'done';
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function loadRun(userId: string, runId: string): Promise<Run> {
  const [row] = await withUserDb(userId, (tx) =>
    tx.select().from(runs).where(eq(runs.id, runId)),
  );
  if (!row) throw notFound('Run not found');
  return row;
}

/** Privileged read for the supervisor, which has no session. */
export async function loadRunForJob(runId: string): Promise<Run> {
  const [row] = await db().select().from(runs).where(eq(runs.id, runId));
  if (!row) throw notFound('Run not found');
  return row;
}

export async function listRuns(userId: string, limit = 20): Promise<Run[]> {
  return withUserDb(userId, (tx) =>
    tx.select().from(runs).where(eq(runs.userId, userId)).orderBy(desc(runs.createdAt)).limit(limit),
  );
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export async function updateRun(
  runId: string,
  patch: Partial<{
    seriesId: string | null;
    stage: RunStage;
    status: RunStatus;
    gateExpiresAt: Date | null;
    estimateCents: number;
    spentCents: number;
    error: string | null;
  }>,
): Promise<Run | null> {
  const [row] = await db().update(runs).set(patch).where(eq(runs.id, runId)).returning();
  return row ?? null;
}

/**
 * Records a stage's result without clobbering the ones before it.
 *
 * Merged in SQL rather than read-modify-written in JS: the supervisor's steps
 * can be re-executed after a crash, and two of them racing on a whole-column
 * write would lose whichever landed first.
 */
export async function recordStageResult(
  runId: string,
  stage: RunStage,
  result: unknown,
): Promise<void> {
  // Both the key and the value are bound parameters. Building this string by
  // hand would put model-generated text — titles, loglines, error messages —
  // straight into a statement.
  await db()
    .update(runs)
    .set({
      meta: sql`coalesce(${runs.meta}, '{}'::jsonb) || jsonb_build_object(${stage}::text, ${JSON.stringify(
        result,
      )}::jsonb)`,
    })
    .where(eq(runs.id, runId));
}

/** Everything this run has actually spent, from the ledger rather than a guess. */
export async function refreshSpend(runId: string): Promise<number> {
  const run = await loadRunForJob(runId);
  if (!run.seriesId) return run.spentCents;

  const [row] = await db()
    .select({ cents: sql<number>`coalesce(sum(${usageLog.costCents}), 0)::int` })
    .from(usageLog)
    .where(and(eq(usageLog.userId, run.userId), eq(usageLog.seriesId, run.seriesId)));

  const spentCents = row?.cents ?? 0;
  await updateRun(runId, { spentCents });
  return spentCents;
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

export interface RunProgress {
  shotsTotal: number;
  shotsReady: number;
  /** Shots with no usable clip. These are the ones that cost you a beat. */
  shotsFailed: number;
  /**
   * Shots that have a clip but lost their line of dialogue.
   *
   * Counted apart from `shotsFailed` because the difference is the whole film.
   * A shot with a ready clip and a failed voice still plays — the assembly
   * includes it, silent — so calling it "failed" reports a hole in the film
   * that is not there. It is worth surfacing, because a missing line is a real
   * loss; it is not worth reporting as a missing shot.
   */
  shotsMissingAudio: number;
  /** True once no shot is still queued or generating. */
  settled: boolean;
}

/**
 * How far the expensive stage has got.
 *
 * The supervisor polls this rather than counting events, because shot jobs are
 * independent fan-out siblings that can be retried, superseded or started by
 * hand from the review board while the run is going. The rows are the truth;
 * the events are only how the work was asked for.
 */
export async function shotProgress(episodeId: string): Promise<RunProgress> {
  const rows = await db()
    .select({ id: shots.id, status: shots.status, version: shots.version })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .where(eq(scenes.episodeId, episodeId));

  const ready = rows.filter((r) => r.status === 'ready').length;
  const failedRows = rows.filter((r) => r.status === 'failed');

  /**
   * Which of the failures still have a picture.
   *
   * `shots.status` is `failed` when *any* required asset failed, which is the
   * right rule for readiness — the render gate must not call an episode
   * finished while a line is missing. It is the wrong rule for a progress
   * counter, because it reports a shot that will appear in the film exactly
   * like one that will not. Only the clip decides whether the beat survives:
   * `buildEpisodeTimeline` blocks on a missing video and lets a null voice
   * through as silence.
   */
  const withClip =
    failedRows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db()
              .select({ shotId: assets.shotId })
              .from(assets)
              .innerJoin(shots, eq(shots.id, assets.shotId))
              .where(
                and(
                  inArray(
                    assets.shotId,
                    failedRows.map((r) => r.id),
                  ),
                  eq(assets.kind, 'video'),
                  eq(assets.status, 'ready'),
                  // The current take only: an old ready clip from a superseded
                  // version is not what this film would play.
                  eq(assets.version, shots.version),
                ),
              )
          )
            .map((r) => r.shotId)
            .filter((id): id is string => Boolean(id)),
        );

  const missingAudio = failedRows.filter((r) => withClip.has(r.id)).length;

  return {
    shotsTotal: rows.length,
    shotsReady: ready,
    shotsFailed: failedRows.length - missingAudio,
    shotsMissingAudio: missingAudio,
    // Settled is about work stopping, not about it succeeding: both kinds of
    // failure are terminal, so both end the wait.
    settled: rows.length > 0 && ready + failedRows.length === rows.length,
  };
}
