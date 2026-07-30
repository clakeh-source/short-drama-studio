'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Film,
  Loader2,
  Play,
  Sparkles,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ReviewTree } from '@/lib/data/review';
import type { RunEstimate } from '@/lib/runs/estimate';
import { cn } from '@/lib/utils';

/**
 * The run, as this page needs it.
 *
 * Declared here rather than imported from the schema: a client component must
 * not reach into `@/lib/db`, and the browser only needs the handful of fields it
 * renders. Dates arrive as strings, because this crossed JSON to get here.
 */
type RunStage = 'bible' | 'cast' | 'script' | 'storyboard' | 'shots' | 'assemble' | 'done';

interface RunView {
  id: string;
  prompt: string;
  targetSeconds: number;
  stage: RunStage;
  status: string;
  estimateCents: number;
  spentCents: number;
  error: string | null;
}

/**
 * The whole product on one page: a sentence in, a film out.
 *
 * Everything here is a view over the run row — the stages, the gate, the clips as
 * they land. Nothing is orchestrated client-side, because a browser tab is the
 * wrong place to own a twenty-minute job: closing it must not stop the film, and
 * reopening it must show exactly where the film got to.
 */

const POLL_MS = 3_000;

/** What each stage is doing, in words that describe the output not the service. */
const STAGE_LABELS: Record<RunStage, string> = {
  bible: 'Developing the show',
  cast: 'Drawing the cast',
  script: 'Writing the script',
  storyboard: 'Planning the shots',
  shots: 'Filming',
  assemble: 'Cutting it together',
  done: 'Finished',
};

const STAGE_ORDER: RunStage[] = [
  'bible',
  'cast',
  'script',
  'storyboard',
  'shots',
  'assemble',
];

interface RunState {
  run: RunView;
  stageIndex: number;
  stageCount: number;
  gateSecondsRemaining: number | null;
  progress: { shotsTotal: number; shotsReady: number; shotsFailed: number; settled: boolean } | null;
  tree: ReviewTree | null;
}

interface EstimateState {
  estimate: RunEstimate & { minutes: number; concurrency: number };
  summary: string;
  affordable: boolean;
  spend: { remainingCents: number; capCents: number; spentCents: number };
}

const LENGTHS = [60, 120, 180, 300] as const;

export function RunWorkspace({ initialRunId }: { initialRunId: string | null }) {
  const [prompt, setPrompt] = useState('');
  const [targetSeconds, setTargetSeconds] = useState<number>(180);
  const [quote, setQuote] = useState<EstimateState | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [state, setState] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* -- the quote, which moves with the length ---------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/runs/estimate?targetSeconds=${targetSeconds}`);
        if (response.ok && !cancelled) setQuote((await response.json()) as EstimateState);
      } catch {
        // A missing quote disables the button; it does not need a toast.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetSeconds]);

  /* -- the run --------------------------------------------------------- */

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const response = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
      if (response.ok) setState((await response.json()) as RunState);
    } catch {
      // Next poll is three seconds away.
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    void refresh();
  }, [runId, refresh]);

  useEffect(() => {
    if (!state) return;
    const settled = ['completed', 'failed', 'cancelled'].includes(state.run.status);
    // Keep polling at a gate: the countdown has to tick down on screen.
    if (settled) return;

    timer.current = setTimeout(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, refresh]);

  async function start() {
    setStarting(true);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, targetSeconds }),
      });
      const payload = (await response.json()) as
        | { run: RunView }
        | { error: { message: string } };

      if (!response.ok) {
        throw new Error('error' in payload ? payload.error.message : 'Could not start the run.');
      }

      setRunId((payload as { run: RunView }).run.id);
      toast.success('Started. You can close this tab — it keeps going.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the run.');
    } finally {
      setStarting(false);
    }
  }

  async function resolveGate(action: 'continue' | 'stop') {
    if (!runId) return;
    try {
      const response = await fetch(`/api/runs/${runId}/gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? 'Could not answer the gate.');
      }
      toast.success(action === 'stop' ? 'Stopped.' : 'Carrying on.');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not answer the gate.');
    }
  }

  /* -- before a run exists ---------------------------------------------- */

  if (!runId || !state) {
    const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            Make a film
          </CardTitle>
          <CardDescription>
            One sentence is enough. Everything after this — the cast, the script, the shots, the
            cut — happens on its own, with a chance to stop it at two points.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="run-prompt">What is it about?</Label>
            <Textarea
              id="run-prompt"
              rows={3}
              placeholder="A freight clerk follows her missing brother's name onto a ferry he never boarded."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>How long?</Label>
            <div className="flex flex-wrap gap-2">
              {LENGTHS.map((seconds) => (
                <Button
                  key={seconds}
                  type="button"
                  variant={targetSeconds === seconds ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTargetSeconds(seconds)}
                >
                  {seconds < 120 ? `${seconds}s` : `${seconds / 60} min`}
                </Button>
              ))}
            </div>
          </div>

          {quote ? (
            <div
              className={cn(
                'rounded-md border p-3 text-sm',
                quote.affordable ? 'border-border' : 'border-destructive/50 bg-destructive/10',
              )}
            >
              <p className={quote.affordable ? '' : 'text-destructive'}>{quote.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Almost all of it is video: {money(quote.estimate.breakdown.video)} of{' '}
                {money(quote.estimate.totalCents)}. Cast stills{' '}
                {money(quote.estimate.breakdown.cast)}, writing{' '}
                {money(quote.estimate.breakdown.script)}, voices{' '}
                {money(quote.estimate.breakdown.voice)}.
              </p>
              {/*
                Said plainly, because the gap between "a 3-minute film" and "25
                minutes of waiting" is where someone decides the app has hung.
              */}
              <p className="mt-1 text-xs text-muted-foreground">
                Takes around {quote.estimate.minutes} minutes — {quote.estimate.concurrency} clips
                are generated at a time. You can close the tab; it keeps going.
              </p>
              {!quote.affordable ? (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {money(quote.spend.remainingCents)} left of your{' '}
                  {money(quote.spend.capCents)} monthly cap — not enough for the worst case
                  ({money(quote.estimate.maxCents)}). Pick a shorter film or raise the cap.
                </p>
              ) : null}
            </div>
          ) : null}

          <Button
            onClick={start}
            disabled={prompt.trim().length < 10 || starting || quote?.affordable === false}
          >
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            Make it
          </Button>
        </CardContent>
      </Card>
    );
  }

  /* -- a run in flight --------------------------------------------------- */

  const { run, progress, tree } = state;
  const finished = run.status === 'completed';
  const stopped = run.status === 'cancelled' || run.status === 'failed';
  const episode = tree?.episodes[0] ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{tree?.title ?? run.prompt}</CardTitle>
            <CardDescription className="line-clamp-2">{run.prompt}</CardDescription>
          </div>
          <StatusBadge status={run.status} />
        </CardHeader>

        <CardContent className="space-y-4">
          <ol className="space-y-1.5">
            {STAGE_ORDER.map((stage, index) => {
              const current = run.stage === stage && !finished && !stopped;
              const done = finished || STAGE_ORDER.indexOf(run.stage) > index;

              return (
                <li key={stage} className="flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]',
                      done && 'border-transparent bg-[var(--success)]/20 text-[var(--success)]',
                      current && 'border-primary text-primary',
                      !done && !current && 'border-border text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="size-3" /> : current ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className={cn(!done && !current && 'text-muted-foreground')}>
                    {STAGE_LABELS[stage]}
                  </span>
                  {stage === 'shots' && progress && progress.shotsTotal > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {progress.shotsReady}/{progress.shotsTotal} shots
                      {progress.shotsFailed > 0 ? ` · ${progress.shotsFailed} failed` : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <p className="text-xs text-muted-foreground">
            Estimated ${(run.estimateCents / 100).toFixed(2)} · spent so far $
            {(run.spentCents / 100).toFixed(2)}
          </p>

          {run.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              {run.error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* -- the gate ------------------------------------------------------ */}

      {run.status === 'awaiting_gate' ? (
        <Card className="border-primary">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm font-medium">
                Have a look before it carries on
              </span>
              {state.gateSecondsRemaining !== null ? (
                <Badge variant="outline">
                  continuing in {state.gateSecondsRemaining}s
                </Badge>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              {run.stage === 'cast'
                ? 'The show and its cast are written. Stopping now costs nothing; carrying on starts drawing the characters.'
                : 'The shot list is planned. This is the last point before the expensive part — carrying on starts filming.'}
            </p>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => resolveGate('continue')}>
                <Play />
                Carry on now
              </Button>
              <Button size="sm" variant="outline" onClick={() => resolveGate('stop')}>
                <Square />
                Stop here
              </Button>
              {tree ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/series/${tree.seriesId}`}>Open and edit</Link>
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* -- the film ------------------------------------------------------ */}

      {episode?.outputUrl ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clapperboard className="size-4" />
              {finished ? 'Your film' : 'Latest cut'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <video
              src={episode.outputUrl}
              controls
              preload="metadata"
              className="max-h-[70vh] rounded-md border border-border"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {episode.durationSeconds ?? '?'}s · {episode.assembly.shotCount} shots
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* -- the clips as they land --------------------------------------- */}

      {episode && episode.assembly.shotCount > 0 ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Film className="size-4" />
              Shots
            </CardTitle>
            {tree ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/series/${tree.seriesId}/review`}>Review board</Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {episode.scenes.flatMap((scene) =>
              scene.shots.map((shot) => (
                <div
                  key={shot.id}
                  title={`${shot.camera} · ${shot.action}`}
                  className={cn(
                    'flex h-20 w-14 items-center justify-center overflow-hidden rounded border',
                    shot.status === 'ready' ? 'border-[var(--success)]/40' : 'border-border',
                  )}
                >
                  {shot.videoUrl ? (
                    <video
                      src={`${shot.videoUrl}#t=0.1`}
                      preload="metadata"
                      muted
                      playsInline
                      className="size-full object-cover"
                    />
                  ) : shot.status === 'generating' || shot.status === 'queued' ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-[9px] text-muted-foreground">
                      {shot.status === 'failed' ? 'failed' : '—'}
                    </span>
                  )}
                </div>
              )),
            )}
          </CardContent>
        </Card>
      ) : null}

      {(finished || stopped) && tree ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={`/series/${tree.seriesId}/review`}>Open the review board</Link>
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRunId(null);
              setState(null);
              setPrompt('');
            }}
          >
            Make another
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'destructive'
        : status === 'cancelled'
          ? 'outline'
          : 'warning';

  return <Badge variant={variant}>{status.replace('_', ' ')}</Badge>;
}
