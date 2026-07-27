'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clapperboard, Loader2, RefreshCw, Sparkles, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useGeneration } from '@/components/generation/use-generation';
import { ShotCard } from './shot-card';
import { DeferredShot, INITIALLY_MOUNTED_SHOTS } from './deferred-shot';
import { useShotShortcuts } from './use-shot-shortcuts';
import type { BoardCharacter, BoardEstimate, BoardScene, BoardShot } from './types';
import { cn, formatCents } from '@/lib/utils';

export interface StoryboardWorkspaceProps {
  episodeId: string;
  episodeNumber: number;
  /** e.g. /series/{id}/episodes/{n} — base for the generate link. */
  episodeHref: string;
  targetSeconds: number;
  hasScript: boolean;
  styleSuffix: string | null;
  /**
   * Series-level, so it is sent once instead of duplicated onto every shot. It is
   * the value the server persisted — identical across all shots of a series — not
   * a client-side recomposition, so a series that ever adds its own exclusions
   * still shows what will actually be sent to the provider.
   */
  negativePrompt: string | null;
  scenes: BoardScene[];
  cast: BoardCharacter[];
  estimate: BoardEstimate | null;
}

type BoardDone = {
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
  preservedOverrides: number;
  targetSeconds: number;
  drift: number;
  costCents: number;
};

export function StoryboardWorkspace(props: StoryboardWorkspaceProps) {
  const router = useRouter();
  const generation = useGeneration<BoardDone>();

  const [scenes, setScenes] = useState(props.scenes);
  const [estimate, setEstimate] = useState(props.estimate);
  const [busyShot, setBusyShot] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const streamRef = useRef<HTMLPreElement>(null);

  /** Keyboard focus for j/k. Independent of DOM focus, which lives in the inputs. */
  const [focusedShotId, setFocusedShotId] = useState<string | null>(null);
  /** Set by `r`; holds the shot awaiting an explicit, priced confirmation. */
  const [pendingRegenerate, setPendingRegenerate] = useState<string | null>(null);

  useEffect(() => setScenes(props.scenes), [props.scenes]);
  useEffect(() => setEstimate(props.estimate), [props.estimate]);
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [generation.text, generation.thinking]);

  const allShots = useMemo(() => scenes.flatMap((s) => s.shots), [scenes]);
  const totalSeconds = allShots.reduce((n, s) => n + s.durationSeconds, 0);
  const drift = props.targetSeconds
    ? Math.abs(totalSeconds - props.targetSeconds) / props.targetSeconds
    : 0;

  const refreshEstimate = useCallback(async () => {
    const response = await fetch(`/api/episodes/${props.episodeId}/estimate`);
    if (response.ok) setEstimate((await response.json()) as BoardEstimate);
  }, [props.episodeId]);

  const generate = useCallback(async () => {
    const result = await generation.run(`/api/episodes/${props.episodeId}/storyboard`);
    if (result) {
      const pct = Math.round(result.drift * 100);
      toast.success(
        `${result.shotCount} shots, ${result.totalSeconds}s against ${result.targetSeconds}s (${pct}% off).` +
          (result.preservedOverrides > 0
            ? ` ${result.preservedOverrides} prompt override${result.preservedOverrides === 1 ? '' : 's'} kept.`
            : ''),
      );
      router.refresh();
      void refreshEstimate();
    }
  }, [generation, props.episodeId, router, refreshEstimate]);

  /* ------------------------------------------------------------ shortcuts */

  const shotIds = useMemo(() => allShots.map((s) => s.id), [allShots]);

  const duplicateShot = useCallback(
    (shotId: string) => void shotAction(shotId, `/api/shots/${shotId}/duplicate`, 'POST'),
    // `shotAction` is defined below and stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useShotShortcuts({
    shotIds,
    focusedShotId,
    onFocus: setFocusedShotId,
    onRequestRegenerate: setPendingRegenerate,
    onDuplicate: duplicateShot,
    // Suspended while a confirmation is up, so `d` cannot fire behind the dialog.
    disabled: pendingRegenerate !== null || generation.state === 'streaming',
  });

  // Keep the keyboard-focused card on screen as j/k walk the list.
  useEffect(() => {
    if (!focusedShotId) return;
    document
      .querySelector(`[data-shot-id="${focusedShotId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedShotId]);

  // A shot that has gone (deleted, or the board was regenerated) cannot stay focused.
  useEffect(() => {
    if (focusedShotId && !shotIds.includes(focusedShotId)) setFocusedShotId(null);
  }, [shotIds, focusedShotId]);

  async function regenerateConfirmed(shotId: string) {
    setPendingRegenerate(null);
    await shotAction(shotId, `/api/shots/${shotId}/generate`, 'POST');
  }

  /* ---------------------------------------------------------------- edits */

  function patchLocal(shotId: string, patch: Partial<BoardShot>) {
    setScenes((prev) =>
      prev.map((scene) => ({
        ...scene,
        shots: scene.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)),
      })),
    );
  }

  async function commit(shotId: string, patch: Partial<BoardShot>) {
    patchLocal(shotId, patch);
    setBusyShot(shotId);
    try {
      const response = await fetch(`/api/shots/${shotId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('Save failed');

      const payload = (await response.json()) as { shot?: BoardShot | null };
      if (payload.shot) patchLocal(shotId, payload.shot);
      void refreshEstimate();
    } catch {
      toast.error('Could not save that change.');
      router.refresh();
    } finally {
      setBusyShot(null);
    }
  }

  async function shotAction(shotId: string, path: string, method: 'POST' | 'DELETE') {
    setBusyShot(shotId);
    try {
      const response = await fetch(path, { method });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? 'That did not work.');
      }
      router.refresh();
      void refreshEstimate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusyShot(null);
    }
  }

  /* ------------------------------------------------------------ reorder */

  function onDrop(targetShotId: string) {
    const sourceId = dragId;
    setDragId(null);
    setDropId(null);
    if (!sourceId || sourceId === targetShotId) return;

    const next = scenes.map((scene) => ({ ...scene, shots: [...scene.shots] }));

    let source: BoardShot | undefined;
    for (const scene of next) {
      const index = scene.shots.findIndex((s) => s.id === sourceId);
      if (index !== -1) {
        source = scene.shots.splice(index, 1)[0];
        break;
      }
    }
    if (!source) return;

    for (const scene of next) {
      const index = scene.shots.findIndex((s) => s.id === targetShotId);
      if (index !== -1) {
        // Dropping onto a shot places the dragged shot before it, in that scene.
        // No `sceneId` to fix up: which scene a shot is in is this tree's shape.
        scene.shots.splice(index, 0, source);
        break;
      }
    }

    setScenes(next);
    void persistOrder(next);
  }

  async function persistOrder(next: BoardScene[]) {
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/shots/reorder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenes: next
            .filter((scene) => scene.shots.length > 0)
            .map((scene) => ({ sceneId: scene.id, shotIds: scene.shots.map((s) => s.id) })),
        }),
      });
      if (!response.ok) throw new Error('Reorder failed');
      toast.success('Order saved.');
      router.refresh();
    } catch {
      toast.error('Could not save the new order.');
      router.refresh();
    }
  }

  /* ---------------------------------------------------------------- view */

  const streaming = generation.state === 'streaming';

  if (!props.hasScript) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <Clapperboard className="size-8 text-muted-foreground" />
          <h2 className="font-medium">No script yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            An episode has to be written before it can be broken into shots.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (allShots.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
          {streaming ? (
            <>
              <Loader2 className="size-8 animate-spin text-primary" />
              <div>
                <h2 className="font-medium">{generation.status || 'Planning coverage…'}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {generation.firstTokenMs !== null
                    ? `First token in ${generation.firstTokenMs}ms`
                    : 'Waiting for the model…'}
                </p>
              </div>
              <StreamView ref={streamRef} text={generation.text} thinking={generation.thinking} />
            </>
          ) : (
            <>
              <Clapperboard className="size-8 text-muted-foreground" />
              <h2 className="font-medium">No storyboard yet</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Break the script into shots. Nothing is generated and nothing is spent — this
                produces prompts you can read and edit first.
              </p>
              {generation.error ? (
                <p className="max-w-md text-sm text-destructive">{generation.error}</p>
              ) : null}
              <Button onClick={generate}>
                <Sparkles />
                Break into shots
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  let runningNumber = 0;

  return (
    <div className="space-y-6">
      {streaming ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>{generation.status || 'Working…'}</span>
              {generation.firstTokenMs !== null ? (
                <Badge variant="outline">first token {generation.firstTokenMs}ms</Badge>
              ) : null}
            </div>
            <StreamView ref={streamRef} text={generation.text} thinking={generation.thinking} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="size-4" />
              Estimated cost to generate
            </CardTitle>
            <CardDescription>
              Priced through the same provider calls Phase 3 will make. Nothing is spent yet.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={generate} disabled={streaming}>
            <RefreshCw className={cn(streaming && 'animate-spin')} />
            Regenerate board
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          <Figure label="Total" value={estimate ? formatCents(estimate.totalCents) : '—'} strong />
          <Figure label="Video" value={estimate ? formatCents(estimate.videoCents) : '—'} />
          <Figure
            label="Voice"
            value={estimate ? formatCents(estimate.voiceCents) : '—'}
            hint={estimate ? `${estimate.voiceShotCount} of ${estimate.shotCount} shots` : undefined}
          />
          <Figure
            label="Runtime"
            value={`${totalSeconds}s`}
            hint={`target ${props.targetSeconds}s`}
            badge={
              <Badge variant={drift <= 0.1 ? 'success' : 'warning'}>
                {Math.round(drift * 100)}% off
              </Badge>
            }
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {allShots.length} shots across {scenes.length} scenes. Drag a card to reorder.
          </p>
          <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Key>j</Key>
            <Key>k</Key>
            <span>move</span>
            <Key>r</Key>
            <span>regenerate</span>
            <Key>d</Key>
            <span>duplicate</span>
          </p>
        </div>
        <Button asChild>
          <Link href={`${props.episodeHref}/generate`}>
            <Sparkles />
            Generate assets
          </Link>
        </Button>
      </div>

      {/*
        `r` asks; it never spends. A keystroke that silently bought a clip would
        break the rule that every generate action is explicit and priced first.
      */}
      {pendingRegenerate ? (
        <Card className="border-primary">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium">
                Regenerate shot{' '}
                {shotIds.indexOf(pendingRegenerate) + 1}?
              </p>
              <p className="text-xs text-muted-foreground">
                This spends with the video and voice providers.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void regenerateConfirmed(pendingRegenerate)}>
                <RefreshCw className="size-4" />
                Yes, regenerate
                {estimate
                  ? ` — ${formatCents(
                      Math.round(estimate.totalCents / Math.max(1, estimate.shotCount)),
                    )}`
                  : ''}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingRegenerate(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {scenes.map((scene) => (
        <div key={scene.id} className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-border pb-2">
            <h2 className="text-sm font-medium">
              Scene {scene.orderIndex + 1} — {scene.location}
            </h2>
            <span className="text-xs text-muted-foreground">{scene.timeOfDay}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {scene.shots.reduce((n, s) => n + s.durationSeconds, 0)}s
            </span>
          </div>

          <div className="space-y-3">
            {scene.shots.map((shot, indexInScene) => {
              runningNumber += 1;
              const onDragOver = (event: React.DragEvent) => {
                event.preventDefault();
                setDropId(shot.id);
              };
              return (
                <DeferredShot
                  key={shot.id}
                  shotId={shot.id}
                  // Counted across the whole episode, not per scene, so the first
                  // screenful is real regardless of how the scenes divide up.
                  initiallyMounted={runningNumber <= INITIALLY_MOUNTED_SHOTS}
                  forceMount={focusedShotId === shot.id}
                  onDragOver={onDragOver}
                  onDrop={() => onDrop(shot.id)}
                >
                <ShotCard
                  shot={shot}
                  scene={scene}
                  displayNumber={runningNumber}
                  cast={props.cast}
                  styleSuffix={props.styleSuffix}
                  negativePrompt={props.negativePrompt}
                  estimateCents={
                    estimate
                      ? Math.round(estimate.totalCents / Math.max(1, estimate.shotCount))
                      : 0
                  }
                  busy={busyShot === shot.id}
                  keyboardFocused={focusedShotId === shot.id}
                  onSelect={() => setFocusedShotId(shot.id)}
                  canMerge={indexInScene < scene.shots.length - 1}
                  onChange={(patch) => patchLocal(shot.id, patch)}
                  onCommit={(patch) => void commit(shot.id, patch)}
                  onSplit={() => void shotAction(shot.id, `/api/shots/${shot.id}/split`, 'POST')}
                  onMerge={() => void shotAction(shot.id, `/api/shots/${shot.id}/merge`, 'POST')}
                  onDelete={() => void shotAction(shot.id, `/api/shots/${shot.id}`, 'DELETE')}
                  onDragStart={() => setDragId(shot.id)}
                  onDragOver={onDragOver}
                  onDrop={() => onDrop(shot.id)}
                  dragging={dragId === shot.id}
                  dropTarget={dropId === shot.id && dragId !== shot.id}
                />
                </DeferredShot>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A keycap, for the shortcut hint. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase">
      {children}
    </kbd>
  );
}

function Figure({
  label,
  value,
  hint,
  strong,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 font-mono tabular-nums',
          strong ? 'text-2xl font-semibold' : 'text-xl',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      {badge ? <div className="mt-1">{badge}</div> : null}
    </div>
  );
}

function StreamView({
  ref,
  text,
  thinking,
}: {
  ref: React.Ref<HTMLPreElement>;
  text: string;
  thinking: string;
}) {
  const showing = text || thinking;
  return (
    <div className="w-full space-y-1">
      <p className="text-left text-xs text-muted-foreground">
        {text ? 'Writing' : thinking ? 'Thinking' : 'Connecting'}
      </p>
      <pre
        ref={ref}
        aria-live="polite"
        className={cn(
          'max-h-48 w-full overflow-y-auto rounded-md bg-muted/40 p-3 text-left font-mono text-xs leading-relaxed',
          text ? 'text-muted-foreground' : 'italic text-muted-foreground/70',
        )}
      >
        {showing || 'Waiting for the model…'}
      </pre>
    </div>
  );
}
