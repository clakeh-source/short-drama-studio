'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ReviewShot, ReviewVersion } from '@/lib/data/review';
import { cn } from '@/lib/utils';

/**
 * One shot, close up: the current take playing, the takes behind it, and the
 * prompt that produced them.
 *
 * The prompt override is the point of this view. Regenerating a shot you did not
 * like is only useful if you can say *why* — otherwise the second take is the
 * first take with a different seed. Editing here changes this shot alone and
 * survives a storyboard rebuild, so it is a note to the model rather than a
 * throwaway.
 */
export function ShotDetail({
  shot,
  sceneLabel,
  onClose,
  onChanged,
}: {
  shot: ReviewShot;
  sceneLabel: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [override, setOverride] = useState(shot.promptOverride ?? '');
  const [busy, setBusy] = useState<null | 'saving' | 'regenerating' | 'reverting'>(null);

  /**
   * Which take the player is showing. Starts on the active one and follows it
   * when the board polls, unless the user is previewing an older take — clicking
   * a version previews it without committing, and Revert is what commits.
   */
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);

  // A regeneration finishing mid-preview should not yank the player away from
  // the take the user is deliberately looking at, but a *closed and reopened*
  // shot should start on the active one again.
  useEffect(() => {
    setPreviewVersion(null);
    setOverride(shot.promptOverride ?? '');
  }, [shot.id, shot.promptOverride]);

  const showing =
    shot.versions.find((v) => v.version === (previewVersion ?? shot.version)) ??
    shot.versions.find((v) => v.active) ??
    null;

  const dirty = (shot.promptOverride ?? '') !== override;

  async function post(url: string, body?: unknown) {
    const response = await fetch(url, {
      method: 'POST',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | { error?: { message?: string } }
      | null;

    if (!response.ok) {
      const message =
        payload && 'error' in payload
          ? ((payload.error as { message?: string } | undefined)?.message ?? 'Request failed')
          : 'Request failed';
      throw new Error(message);
    }
    return payload;
  }

  async function saveOverride() {
    setBusy('saving');
    try {
      await fetch(`/api/shots/${shot.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ promptOverride: override.trim() || null }),
      }).then(async (r) => {
        if (!r.ok) throw new Error('Could not save the prompt.');
      });
      toast.success('Prompt saved. Regenerate to use it.');
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the prompt.');
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy('regenerating');
    try {
      // Save first when the prompt has been edited, or the new take is generated
      // from the old prompt and the edit looks like it did nothing.
      if (dirty) {
        await fetch(`/api/shots/${shot.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ promptOverride: override.trim() || null }),
        });
      }

      const result = (await post(`/api/shots/${shot.id}/regenerate`)) as { version?: number };
      setPreviewVersion(null);
      toast.success(`Take ${result.version ?? ''} queued.`);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not regenerate.');
    } finally {
      setBusy(null);
    }
  }

  async function revert(version: number) {
    setBusy('reverting');
    try {
      await post(`/api/shots/${shot.id}/revert`, { version });
      setPreviewVersion(null);
      toast.success(`Reverted to take ${version}.`);
      // The board owns the active URL; refreshing it is what makes the change
      // show up everywhere the shot appears, not just in this player.
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revert.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label={`Shot ${shot.orderIndex + 1}`}
        className="my-8 w-full max-w-2xl space-y-4 rounded-lg border border-border bg-card p-5 shadow-lg"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">Shot {shot.orderIndex + 1}</h2>
            <p className="truncate text-sm text-muted-foreground">{sceneLabel}</p>
          </div>
          <Badge variant="outline">{shot.status}</Badge>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        {/* -- the player ------------------------------------------------- */}

        <div className="overflow-hidden rounded-md border border-border bg-muted/30">
          {showing?.url ? (
            <video
              // Keyed on the version so switching takes reloads the element
              // rather than leaving the previous frame on screen.
              key={showing.version}
              src={showing.url}
              controls
              preload="metadata"
              className="max-h-[420px] w-full"
            />
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {shot.status === 'generating' || shot.status === 'queued'
                ? 'Generating…'
                : 'No clip for this shot yet.'}
            </div>
          )}
        </div>

        {shot.error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {shot.error}
          </p>
        ) : null}

        {/* -- version history -------------------------------------------- */}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label>Takes</Label>
            <span className="text-xs text-muted-foreground">
              {shot.versions.length === 1
                ? 'one take so far — click to preview'
                : `the last ${shot.versions.length} are kept — click to preview`}
            </span>
          </div>

          {shot.versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No takes yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {shot.versions.map((version) => (
                <VersionTile
                  key={version.assetId}
                  version={version}
                  previewing={(previewVersion ?? shot.version) === version.version}
                  busy={busy !== null}
                  onPreview={() => setPreviewVersion(version.version)}
                  onRevert={() => revert(version.version)}
                />
              ))}
            </div>
          )}
        </div>

        {/* -- the prompt --------------------------------------------------- */}

        <div className="space-y-1.5">
          <Label htmlFor={`override-${shot.id}`}>
            Prompt override
            <span className="ml-2 font-normal text-muted-foreground">
              replaces the composed prompt for this shot only
            </span>
          </Label>
          <Textarea
            id={`override-${shot.id}`}
            rows={4}
            className="font-mono text-xs"
            placeholder={shot.videoPrompt ?? 'No composed prompt yet.'}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
          {shot.dialogue ? (
            <p className="text-xs text-muted-foreground">
              Dialogue: <span className="italic">“{shot.dialogue}”</span>
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={saveOverride}
            disabled={!dirty || busy !== null}
          >
            {busy === 'saving' ? <Loader2 className="animate-spin" /> : <Check />}
            Save prompt
          </Button>

          <Button size="sm" onClick={regenerate} disabled={busy !== null}>
            {busy === 'regenerating' ? <Loader2 className="animate-spin" /> : <Sparkles />}
            Regenerate
          </Button>

          <span className="text-xs text-muted-foreground">
            Regenerating keeps the current take — it becomes take {shot.version + 1}.
          </span>
        </div>
      </div>
    </div>
  );
}

function VersionTile({
  version,
  previewing,
  busy,
  onPreview,
  onRevert,
}: {
  version: ReviewVersion;
  previewing: boolean;
  busy: boolean;
  onPreview: () => void;
  onRevert: () => void;
}) {
  return (
    <div
      className={cn(
        'w-28 overflow-hidden rounded-md border',
        previewing ? 'border-primary' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        className="block w-full"
        aria-label={`Preview take ${version.version}`}
      >
        <div className="flex h-16 items-center justify-center bg-muted/40">
          {version.url ? (
            <video
              src={`${version.url}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              className="size-full object-cover"
            />
          ) : (
            <span className="text-[10px] text-muted-foreground">{version.status}</span>
          )}
        </div>
      </button>

      <div className="space-y-1 p-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium">Take {version.version}</span>
          {version.active ? (
            <Badge variant="success" className="px-1 py-0 text-[9px]">
              active
            </Badge>
          ) : null}
        </div>

        {!version.active && version.url ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full px-1 text-[11px]"
            onClick={onRevert}
            disabled={busy}
          >
            <RotateCcw className="size-3" />
            Revert
          </Button>
        ) : null}
      </div>
    </div>
  );
}
