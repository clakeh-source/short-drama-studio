'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Copy,
  Download,
  Film,
  Info,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn, formatCents } from '@/lib/utils';

export interface RenderRow {
  id: string;
  provider: string;
  status: string;
  error: string | null;
  costCents: number;
  durationSeconds: number | null;
  createdAt: string;
  downloadUrl: string | null;
  meta: unknown;
}

export interface RendersPayload {
  renders: RenderRow[];
  readiness: {
    ready: boolean;
    blockingShots: Array<{ shotId: string; orderIndex: number; status: string; reason: string }>;
    shotCount: number;
    clipCount: number;
  };
  provider: string;
  /** What the next render would cost, priced before the click. */
  estimateCents: number;
  timeline: {
    totalSeconds: number;
    clipCount: number;
    voiceCount: number;
    captionCount: number;
    resolution: string;
    hasMusic: boolean;
    clips: Array<{ shotId: string; startAt: number; durationSeconds: number }>;
  };
  active: boolean;
}

export interface ExportCopyPayload {
  caption: string;
  hashtags: string[];
  alternates: string[];
}

export interface ExportPanelProps {
  episodeId: string;
  seriesId: string;
  captionStyleId: string;
  captionStyles: Array<{ id: string; label: string }>;
  initial: RendersPayload;
}

const POLL_MS = 4_000;

export function ExportPanel(props: ExportPanelProps) {
  const [state, setState] = useState(props.initial);
  const [rendering, setRendering] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copy, setCopy] = useState<ExportCopyPayload | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [styleId, setStyleId] = useState(props.captionStyleId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * How many renders existed when we last queued one.
   *
   * The row is created by the render job, not by the POST, so the refresh that
   * follows a queue almost always sees nothing yet — which made `state.active`
   * false and stopped the poll loop before it began. The render then finished,
   * or failed, with the panel showing no trace of either: the first real render
   * failed on a missing libass and the reason only existed in the database.
   *
   * Holding the pre-queue count lets us keep polling until the row we are
   * waiting for actually appears.
   */
  const awaitingSince = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/renders`, {
        cache: 'no-store',
      });
      if (response.ok) setState((await response.json()) as RendersPayload);
    } catch {
      // A dropped poll is not worth surfacing.
    }
  }, [props.episodeId]);

  // A render we queued has landed once a new row exists, whatever its status.
  const awaitingRow =
    awaitingSince.current !== null && state.renders.length <= awaitingSince.current;
  if (!awaitingRow) awaitingSince.current = null;

  useEffect(() => {
    if (!state.active && !awaitingRow) {
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    timer.current = setTimeout(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, awaitingRow, refresh]);

  async function startRender() {
    setRendering(true);
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/render`, { method: 'POST' });
      const payload = (await response.json()) as
        | { queued: boolean; message?: string; estimateCents?: number }
        | { error: { message: string } };

      if (!response.ok) {
        throw new Error('error' in payload ? payload.error.message : 'Could not start the render.');
      }
      if ('queued' in payload && !payload.queued) {
        toast.info(payload.message ?? 'A render is already running.');
      } else {
        toast.success('Render queued.');
        // Keep polling until this render's row shows up, even though the POST
        // returns before the job has created it.
        awaitingSince.current = state.renders.length;
      }
      setConfirming(false);
      void refresh();
    } catch (error) {
      // Left open, so the estimate and the error are visible together.
      toast.error(error instanceof Error ? error.message : 'Could not start the render.', {
        duration: 12_000,
      });
    } finally {
      setRendering(false);
    }
  }

  async function generateCopy() {
    setCopyBusy(true);
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}/export-copy`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Could not write the caption.');
      setCopy((await response.json()) as ExportCopyPayload);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not write the caption.');
    } finally {
      setCopyBusy(false);
    }
  }

  async function saveStyle(next: string) {
    setStyleId(next);
    try {
      const response = await fetch(`/api/series/${props.seriesId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ captionStyleId: next }),
      });
      if (!response.ok) throw new Error('Save failed');
      toast.success('Caption style saved. It applies to the next render.');
    } catch {
      toast.error('Could not save the caption style.');
    }
  }

  const latest = state.renders[0] ?? null;
  const ready = state.renders.find((r) => r.status === 'ready' && r.downloadUrl);

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- preview */}
      {ready?.downloadUrl ? (
        <PreviewPlayer url={ready.downloadUrl} clips={state.timeline.clips} />
      ) : null}

      {/* ----------------------------------------------------------- render */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Assemble</CardTitle>
            <CardDescription>
              {state.timeline.clipCount} clips · {state.timeline.voiceCount} voice tracks ·{' '}
              {state.timeline.captionCount} caption cues ·{' '}
              {Math.round(state.timeline.totalSeconds)}s · {state.timeline.resolution}
              {state.timeline.hasMusic ? ' · music bed' : ''} ·{' '}
              <span className="font-medium">{formatCents(state.estimateCents)}</span> to render
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{state.provider}</Badge>
            {state.active ? (
              <Badge variant="default">
                <Loader2 className="size-3 animate-spin" />
                rendering
              </Badge>
            ) : null}
            <Button
              onClick={() => setConfirming(true)}
              disabled={rendering || state.active || !state.readiness.ready}
            >
              {rendering || state.active ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Clapperboard />
              )}
              {latest ? 'Render again' : 'Render episode'}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/*
            Rendering costs money, so it goes through the same explicit
            confirmation as generation: the estimate is shown before the click,
            never only after the job is queued.
          */}
          {confirming ? (
            <div className="space-y-3 rounded-md border border-primary p-4">
              <div>
                <p className="text-sm font-medium">
                  {latest ? 'Render this episode again?' : 'Render this episode?'}
                </p>
                <p className="text-muted-foreground text-sm">
                  This spends real money with the render provider.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={startRender} disabled={rendering}>
                  {rendering ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                  Yes, render — {formatCents(state.estimateCents)}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {!state.readiness.ready ? (
            <div className="rounded-lg border border-[var(--warning)] bg-[var(--warning)]/10 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4 text-[var(--warning)]" />
                {state.readiness.blockingShots.length} of {state.readiness.shotCount} shots have no
                clip
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {state.readiness.blockingShots.slice(0, 6).map((shot) => (
                  <li key={shot.shotId}>
                    Shot {shot.orderIndex + 1} — {shot.reason}
                  </li>
                ))}
                {state.readiness.blockingShots.length > 6 ? (
                  <li>…and {state.readiness.blockingShots.length - 6} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="caption-style">Caption style</Label>
            <Select
              id="caption-style"
              value={styleId}
              onChange={(e) => void saveStyle(e.target.value)}
            >
              {props.captionStyles.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Burned in, and kept clear of the top 10% and bottom 12% where platforms draw their
              own interface.
            </p>
          </div>

          {state.renders.length > 0 ? (
            <div className="divide-y divide-border rounded-lg border border-border">
              {state.renders.map((render) => (
                <div key={render.id} className="flex flex-wrap items-center gap-3 p-3">
                  <StatusBadge status={render.status} />
                  <span className="text-xs text-muted-foreground">
                    {new Date(render.createdAt).toISOString().replace('T', ' ').slice(0, 16)}
                  </span>
                  {render.durationSeconds ? (
                    <span className="font-mono text-xs">{render.durationSeconds}s</span>
                  ) : null}
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatCents(render.costCents)}
                  </span>

                  {render.error ? (
                    <p className="w-full rounded bg-destructive/10 p-2 text-xs text-destructive">
                      {render.error}
                    </p>
                  ) : null}

                  <div className="ml-auto flex items-center gap-2">
                    {render.status === 'failed' ? (
                      <Button size="sm" variant="outline" onClick={startRender} disabled={rendering}>
                        <RotateCcw />
                        Retry
                      </Button>
                    ) : null}
                    {render.downloadUrl ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={render.downloadUrl} download={`episode.mp4`}>
                          <Download />
                          MP4
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- copy */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Caption and hashtags</CardTitle>
            <CardDescription>Written from this episode&rsquo;s synopsis and cliffhanger.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={generateCopy} disabled={copyBusy}>
            {copyBusy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {copy ? 'Rewrite' : 'Write it'}
          </Button>
        </CardHeader>
        {copy ? (
          <CardContent className="space-y-3">
            <CopyBlock label="Caption" value={`${copy.caption}\n\n${copy.hashtags.join(' ')}`} />
            {copy.alternates.length > 0 ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Alternative openings</Label>
                {copy.alternates.map((line) => (
                  <CopyBlock key={line} label="" value={line} compact />
                ))}
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- disclosure */}
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">This video is AI-generated.</p>
            <p>
              The footage, voices and captions were produced by generative models — no camera and
              no performers were involved. Most platforms require you to disclose that when you
              upload, and some will label it automatically. Every render is stamped{' '}
              <code className="font-mono text-xs">ai_generated</code> in its metadata.
            </p>
            <p>
              Any music you added is yours to clear. This app ships no music library and makes no
              licensing checks.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** 9:16 player with a shot-boundary scrubber. */
function PreviewPlayer({
  url,
  clips,
}: {
  url: string;
  clips: Array<{ shotId: string; startAt: number; durationSeconds: number }>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const total = clips.reduce((end, c) => Math.max(end, c.startAt + c.durationSeconds), 0);
  const activeIndex = clips.findIndex(
    (c) => currentTime >= c.startAt && currentTime < c.startAt + c.durationSeconds,
  );

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    void video.play();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Film className="size-4" />
          Preview
        </CardTitle>
        <CardDescription>
          Click a shot to jump to it. This is the file that downloads.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="mx-auto w-full max-w-[280px]">
          <video
            ref={videoRef}
            src={url}
            controls
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            className="w-full rounded-lg border border-border bg-black aspect-vertical"
          />
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
            <span>
              Shot {activeIndex >= 0 ? activeIndex + 1 : '—'} of {clips.length}
            </span>
            <span className="font-mono tabular-nums">
              {currentTime.toFixed(1)}s / {total.toFixed(1)}s
            </span>
          </div>
          <div className="flex gap-0.5" role="group" aria-label="Jump to shot">
            {clips.map((clip, index) => (
              <button
                key={clip.shotId}
                type="button"
                onClick={() => seekTo(clip.startAt)}
                title={`Shot ${index + 1} — ${clip.startAt.toFixed(1)}s`}
                aria-label={`Jump to shot ${index + 1}`}
                style={{ flexGrow: clip.durationSeconds }}
                className={cn(
                  'h-6 rounded-sm border text-[10px] font-mono transition-colors',
                  index === activeIndex
                    ? 'border-primary bg-primary/25 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:bg-accent',
                )}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CopyBlock({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copyIt() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error('Could not reach the clipboard. Select the text and copy it manually.');
    }
  }

  return (
    <div className="space-y-1.5">
      {label ? <Label className="text-xs">{label}</Label> : null}
      <div className="flex items-start gap-2">
        <pre
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-sm',
            compact && 'py-2 text-xs',
          )}
        >
          {value}
        </pre>
        <Button variant="ghost" size="icon" onClick={copyIt} aria-label={`Copy ${label || 'text'}`}>
          {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
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
