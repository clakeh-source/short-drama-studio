'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  Clock,
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatCents } from '@/lib/utils';

export interface ShotStatusRow {
  shotId: string;
  orderIndex: number;
  durationSeconds: number;
  status: string;
  retryCount: number;
  dialogue: string | null;
  videoUrl: string | null;
  voiceUrl: string | null;
  voiceOverruns: boolean;
  suggestedDurationSeconds: number | null;
  video: { status: string; costCents: number; error: string | null } | null;
  voice: {
    status: string;
    costCents: number;
    error: string | null;
    durationSeconds: number | null;
  } | null;
}

export interface StatusPayload {
  episodeStatus: string;
  shots: ShotStatusRow[];
  counts: Record<string, number>;
  active: boolean;
  totalCostCents: number;
}

export interface GenerationPanelProps {
  episodeId: string;
  estimateCents: number;
  spentCents: number;
  capCents: number;
  initial: StatusPayload;
}

/** How often to poll while jobs are moving. */
const POLL_MS = 3_000;

export function GenerationPanel(props: GenerationPanelProps) {
  const router = useRouter();
  const [status, setStatus] = useState(props.initial);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [busyShot, setBusyShot] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set when we have asked for generation but the queue has not caught up yet.
   *
   * The POST returns as soon as the fan-out function is *enqueued*, and marking
   * the shots `queued` happens a second or two later inside it. The refresh that
   * follows therefore sees nothing active, which used to stop the poll loop
   * before it began: the board sat at "0 of 7 shots ready" while all seven clips
   * generated and finished behind it. The end-to-end run is what caught this.
   */
  const awaitingQueue = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/status`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      setStatus((await response.json()) as StatusPayload);
    } catch {
      // A dropped poll is not worth surfacing; the next one will land.
    }
  }, [props.episodeId]);

  // Work has reached the queue, so the normal `active` signal takes over.
  if (status.active) awaitingQueue.current = false;

  // Poll while something is in flight, or while we are waiting for it to be.
  useEffect(() => {
    if (!status.active && !awaitingQueue.current) {
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    timer.current = setTimeout(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, refresh]);

  async function generateAll() {
    setWorking(true);
    setConfirming(false);
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Makes a double-submit a no-op rather than a double charge.
          'idempotency-key': `episode-${props.episodeId}-${Date.now()}`,
        },
        body: JSON.stringify({}),
      });

      const payload = (await response.json()) as
        | { queued: number; estimateCents: number }
        | { error: { message: string } };

      if (!response.ok) {
        const message = 'error' in payload ? payload.error.message : 'Could not start generation.';
        toast.error(message, { duration: 12_000 });
        return;
      }

      const queued = 'queued' in payload ? payload.queued : 0;
      toast.success(
        queued === 0
          ? 'Every shot is already generated.'
          : `${queued} shot${queued === 1 ? '' : 's'} queued. Three run at a time.`,
      );
      // Keep polling until the fan-out has actually marked the shots queued.
      if (queued > 0) awaitingQueue.current = true;
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start generation.');
    } finally {
      setWorking(false);
    }
  }

  async function retryShot(shotId: string) {
    setBusyShot(shotId);
    try {
      const response = await fetch(`/api/shots/${shotId}/generate`, { method: 'POST' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? 'Could not retry that shot.');
      }
      toast.success('Shot queued.');
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not retry that shot.');
    } finally {
      setBusyShot(null);
    }
  }

  async function extendShot(shotId: string) {
    setBusyShot(shotId);
    try {
      const response = await fetch(`/api/shots/${shotId}/extend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as
        | { updated: boolean; durationSeconds: number; message?: string }
        | { error: { message: string } };

      if (!response.ok) {
        throw new Error('error' in payload ? payload.error.message : 'Could not extend the shot.');
      }
      if ('updated' in payload && !payload.updated) {
        toast.error(payload.message ?? 'The shot is already as long as it can be.');
        return;
      }
      if ('durationSeconds' in payload) {
        toast.success(
          `Shot extended to ${payload.durationSeconds}s. Regenerate it to get a clip that length.`,
        );
      }
      void refresh();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not extend the shot.');
    } finally {
      setBusyShot(null);
    }
  }

  const ready = status.counts.ready ?? 0;
  const failed = status.counts.failed ?? 0;
  const total = status.shots.length;
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
  const overrunning = status.shots.filter((s) => s.voiceOverruns);
  const remaining = Math.max(0, props.capCents - props.spentCents);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Generation</CardTitle>
            <CardDescription>
              {ready} of {total} shots ready
              {failed > 0 ? ` · ${failed} failed` : ''}
              {status.active ? ' · three running at a time' : ''}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status.active ? (
              <Badge variant="default">
                <Loader2 className="size-3 animate-spin" />
                running
              </Badge>
            ) : null}
            <Button onClick={() => setConfirming(true)} disabled={working || status.active}>
              {working ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Generate all pending
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Shots generated"
          >
            <div className="h-full bg-[var(--success)] transition-all" style={{ width: `${pct}%` }} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="Spent on this episode" value={formatCents(status.totalCostCents)} />
            <Figure label="Estimate for what is left" value={formatCents(props.estimateCents)} />
            <Figure
              label="Left this month"
              value={formatCents(remaining)}
              hint={`cap ${formatCents(props.capCents)}`}
            />
          </div>
        </CardContent>
      </Card>

      {confirming ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">Generate everything still pending?</CardTitle>
            <CardDescription>
              This spends real money with the video and voice providers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-1 text-sm">
              <Row label="Estimated cost" value={formatCents(props.estimateCents)} strong />
              <Row label="Already spent this month" value={formatCents(props.spentCents)} />
              <Row label="Monthly cap" value={formatCents(props.capCents)} />
              <Row
                label="Remaining after this"
                value={formatCents(Math.max(0, remaining - props.estimateCents))}
              />
            </dl>
            <div className="flex gap-2">
              <Button onClick={generateAll} disabled={working}>
                {working ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Yes, generate — {formatCents(props.estimateCents)}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {overrunning.length > 0 ? (
        <Card className="border-[var(--warning)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-[var(--warning)]" />
              {overrunning.length} line{overrunning.length === 1 ? '' : 's'} longer than the shot
            </CardTitle>
            <CardDescription>
              The voiceover would be cut off. Lengthen the shot, or shorten the line on the
              storyboard.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overrunning.map((shot) => (
              <div
                key={shot.shotId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  shot {shot.orderIndex + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  &ldquo;{shot.dialogue}&rdquo;
                </span>
                <span className="font-mono text-xs">
                  {shot.voice?.durationSeconds}s in a {shot.durationSeconds}s shot
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void extendShot(shot.shotId)}
                  disabled={busyShot === shot.shotId}
                >
                  {busyShot === shot.shotId ? <Loader2 className="animate-spin" /> : <Wand2 />}
                  Extend to {shot.suggestedDurationSeconds}s
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {status.shots.map((shot) => (
          <ShotStatusCard
            key={shot.shotId}
            shot={shot}
            busy={busyShot === shot.shotId}
            onRetry={() => void retryShot(shot.shotId)}
          />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ShotStatusCard({
  shot,
  busy,
  onRetry,
}: {
  shot: ShotStatusRow;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-border bg-card p-3">
      <div className="w-24 shrink-0">
        {shot.videoUrl ? (
          <video
            src={shot.videoUrl}
            controls
            preload="metadata"
            className="w-full rounded-md border border-border bg-black aspect-vertical"
          />
        ) : (
          <div className="flex w-full items-center justify-center rounded-md border border-border bg-muted/40 aspect-vertical">
            <StatusIcon status={shot.status} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">shot {shot.orderIndex + 1}</span>
          <StatusBadge status={shot.status} />
          <span className="font-mono text-xs text-muted-foreground">{shot.durationSeconds}s</span>
          {shot.retryCount > 0 ? (
            <Badge variant="outline">attempt {shot.retryCount + 1}</Badge>
          ) : null}
          {shot.voiceOverruns ? <Badge variant="warning">line overruns</Badge> : null}
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCents((shot.video?.costCents ?? 0) + (shot.voice?.costCents ?? 0))}
          </span>
        </div>

        {shot.dialogue ? (
          <p className="truncate text-sm text-muted-foreground">&ldquo;{shot.dialogue}&rdquo;</p>
        ) : null}

        {shot.video?.error ? (
          <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {shot.video.error}
          </p>
        ) : null}
        {shot.voice?.error ? (
          <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            Voice: {shot.voice.error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {shot.voiceUrl ? (
            <audio src={shot.voiceUrl} controls preload="metadata" className="h-8" />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={busy || shot.status === 'queued' || shot.status === 'generating'}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {shot.status === 'ready' ? 'Regenerate' : 'Retry'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const className = 'size-5';
  switch (status) {
    case 'ready':
      return <CircleCheck className={cn(className, 'text-[var(--success)]')} />;
    case 'failed':
      return <XCircle className={cn(className, 'text-destructive')} />;
    case 'generating':
      return <Loader2 className={cn(className, 'animate-spin text-primary')} />;
    case 'queued':
      return <Clock className={cn(className, 'text-muted-foreground')} />;
    default:
      return <CircleDashed className={cn(className, 'text-muted-foreground')} />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'ready'
      ? 'success'
      : status === 'failed'
        ? 'destructive'
        : status === 'generating' || status === 'queued'
          ? 'default'
          : 'outline';

  return (
    <Badge variant={variant}>
      {status === 'generating' ? <Loader2 className="size-3 animate-spin" /> : null}
      {status}
    </Badge>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-mono tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}
