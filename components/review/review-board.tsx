'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Clapperboard,
  Film,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ShotDetail } from '@/components/review/shot-detail';
import type { ReviewEpisode, ReviewScene, ReviewShot, ReviewTree } from '@/lib/data/review';
import { cn } from '@/lib/utils';

/**
 * Poll interval while anything is generating.
 *
 * Five seconds is the spec's, and it is also about the fastest that is
 * worthwhile: a Kling clip takes tens of seconds at best, so a shorter interval
 * would mostly re-fetch a board that has not changed.
 */
const POLL_MS = 5_000;

/**
 * How often an idle board checks anyway.
 *
 * The fast poll only runs while this board knows something is moving, which is
 * true the moment *it* starts a generation. It is not true when the work was
 * started somewhere else — another tab, a worker finishing a job queued before
 * the page loaded — and a board that never looks again in that case just sits
 * there being quietly wrong. Thirty seconds is cheap enough to leave running and
 * short enough that nobody reaches for the refresh button.
 */
const IDLE_POLL_MS = 30_000;

export function ReviewBoard({ seriesId, initial }: { seriesId: string; initial: ReviewTree }) {
  const [tree, setTree] = useState(initial);
  const [openShotId, setOpenShotId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** How long the last poll took, so the next one keeps the cadence honest. */
  const lastDuration = useRef(0);

  const refresh = useCallback(async () => {
    const started = Date.now();
    try {
      const response = await fetch(`/api/series/${seriesId}/review`, { cache: 'no-store' });
      if (response.ok) setTree((await response.json()) as ReviewTree);
    } catch {
      // A dropped poll is not worth a toast — the next one is five seconds away.
    } finally {
      lastDuration.current = Date.now() - started;
    }
  }, [seriesId]);

  /**
   * Fast while something is in flight, slow otherwise.
   *
   * Polling a finished series every five seconds burns a request for as long as
   * the tab is open and re-signs every URL in the tree each time — but never
   * polling an idle board means it silently stops reflecting reality the moment
   * anything changes outside this page.
   */
  useEffect(() => {
    const target = tree.active ? POLL_MS : IDLE_POLL_MS;

    /**
     * Fixed *rate*, not fixed delay.
     *
     * Waiting the full interval after each response makes the real cycle the
     * interval plus a round trip — measured at 5.7s against a stated 5s, which
     * is the difference between meeting "updates within five seconds" and
     * narrowly missing it. Subtracting the last request's duration keeps the
     * cadence at the number on the badge. The floor stops a slow connection
     * from turning this into a busy loop.
     */
    const delay = Math.max(500, target - lastDuration.current);

    timer.current = setTimeout(() => void refresh(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tree, refresh]);

  async function manualRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const openShot = findShot(tree, openShotId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {tree.active ? (
          <Badge variant="warning" className="gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            Generating — updating every {POLL_MS / 1000}s
          </Badge>
        ) : (
          <Badge variant="outline">Idle</Badge>
        )}
        <Button variant="ghost" size="sm" onClick={manualRefresh} disabled={refreshing}>
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {tree.episodes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            This series has no episodes yet.
          </CardContent>
        </Card>
      ) : (
        tree.episodes.map((episode) => (
          <EpisodeNode
            key={episode.id}
            episode={episode}
            onOpenShot={setOpenShotId}
            onChanged={refresh}
          />
        ))
      )}

      {openShot ? (
        <ShotDetail
          shot={openShot.shot}
          sceneLabel={`Scene ${openShot.scene.orderIndex + 1} · ${openShot.scene.location}`}
          onClose={() => setOpenShotId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EpisodeNode({
  episode,
  onOpenShot,
  onChanged,
}: {
  episode: ReviewEpisode;
  onOpenShot: (shotId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [assembling, setAssembling] = useState(false);

  const { assembly } = episode;

  /**
   * The tooltip the spec asks for, and the reason it exists: a disabled button
   * with no explanation is a dead end. `title` gives the hover text; the list
   * below gives the same information to anyone not using a mouse.
   */
  const blockedReason = assembly.ready
    ? undefined
    : assembly.shotCount === 0
      ? 'This episode has no shots yet.'
      : `${assembly.blocking.length} of ${assembly.shotCount} ` +
        `${assembly.blocking.length === 1 ? 'shots is' : 'shots are'} not ready yet.`;

  async function assemble() {
    setAssembling(true);
    try {
      const response = await fetch(`/api/episodes/${episode.id}/assemble`, { method: 'POST' });
      const payload = (await response.json()) as
        | { queued: boolean; message?: string }
        | { error: { message: string } };

      if (!response.ok) {
        throw new Error('error' in payload ? payload.error.message : 'Could not assemble.');
      }
      toast.success('Assembly queued.');
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not assemble.');
    } finally {
      setAssembling(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 p-4">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronRight
              className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')}
            />
            <Film className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">
              {String(episode.number).padStart(2, '0')} · {episode.title || 'Untitled'}
            </span>
            <Badge variant="outline">{episode.status}</Badge>
            <span className="text-sm text-muted-foreground">
              {assembly.readyShotCount}/{assembly.shotCount} shots ready
            </span>
          </button>

          <Button
            size="sm"
            onClick={assemble}
            disabled={!assembly.ready || assembling}
            title={blockedReason}
            aria-describedby={blockedReason ? `blocked-${episode.id}` : undefined}
          >
            {assembling ? <Loader2 className="animate-spin" /> : <Clapperboard />}
            Assemble
          </Button>
        </div>

        {!assembly.ready && assembly.blocking.length > 0 ? (
          <p
            id={`blocked-${episode.id}`}
            className="flex items-start gap-2 border-t border-border px-4 py-2 text-sm text-muted-foreground"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Cannot assemble yet — {blockedReason}{' '}
              {assembly.blocking
                .slice(0, 4)
                .map(
                  (b) =>
                    `scene ${b.sceneIndex + 1} shot ${b.shotIndex + 1} — ` +
                    // The reasons are written as sentences for the API's
                    // `blockingShots`; inline in a list they read better joined.
                    b.reason.replace(/^It/, 'it').replace(/^Its/, 'its').replace(/\.$/, ''),
                )
                .join('; ')}
              {assembly.blocking.length > 4 ? `; and ${assembly.blocking.length - 4} more` : ''}
            </span>
          </p>
        ) : null}

        {episode.outputUrl ? (
          <div className="border-t border-border px-4 py-3">
            <video
              src={episode.outputUrl}
              controls
              preload="metadata"
              className="max-h-96 rounded-md border border-border"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Assembled episode · {episode.durationSeconds ?? '?'}s
            </p>
          </div>
        ) : null}

        {open ? (
          <div className="border-t border-border">
            {episode.scenes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No scenes yet — break the script down first.
              </p>
            ) : (
              episode.scenes.map((scene) => (
                <SceneNode key={scene.id} scene={scene} onOpenShot={onOpenShot} />
              ))
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SceneNode({
  scene,
  onOpenShot,
}: {
  scene: ReviewScene;
  onOpenShot: (shotId: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-accent/40"
      >
        <ChevronRight
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="truncate text-sm font-medium">
          Scene {scene.orderIndex + 1} · {scene.location || 'Unspecified'}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{scene.timeOfDay}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {scene.shots.length} shots
        </span>
      </button>

      {open ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3 pl-10">
          {scene.shots.map((shot) => (
            <ShotTile key={shot.id} shot={shot} onOpen={() => onOpenShot(shot.id)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_VARIANT: Record<string, 'outline' | 'success' | 'warning' | 'destructive'> = {
  pending: 'outline',
  queued: 'warning',
  generating: 'warning',
  ready: 'success',
  failed: 'destructive',
};

function ShotTile({ shot, onOpen }: { shot: ReviewShot; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-32 overflow-hidden rounded-md border border-border text-left transition-colors hover:border-primary"
    >
      <div className="relative flex h-24 items-center justify-center bg-muted/40">
        {shot.videoUrl ? (
          /**
           * The first frame, without generating and storing a separate
           * thumbnail for every take. `#t=0.1` tells the browser to seek there
           * while loading metadata, so it paints that frame as the poster —
           * a real first frame rather than a placeholder, and no extra objects
           * in the bucket to keep in step with the clip.
           */
          <video
            src={`${shot.videoUrl}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            className="size-full object-cover"
          />
        ) : shot.status === 'generating' || shot.status === 'queued' ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <span className="text-xs text-muted-foreground">no clip</span>
        )}
      </div>

      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">Shot {shot.orderIndex + 1}</span>
          <Badge variant={STATUS_VARIANT[shot.status] ?? 'outline'} className="px-1 py-0 text-[10px]">
            {shot.status}
          </Badge>
        </div>
        <p className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
          {shot.camera} · {shot.action}
        </p>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function findShot(
  tree: ReviewTree,
  shotId: string | null,
): { shot: ReviewShot; scene: ReviewScene } | null {
  if (!shotId) return null;
  for (const episode of tree.episodes) {
    for (const scene of episode.scenes) {
      const shot = scene.shots.find((s) => s.id === shotId);
      if (shot) return { shot, scene };
    }
  }
  return null;
}
