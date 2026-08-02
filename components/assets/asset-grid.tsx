'use client';

import { useMemo, useState } from 'react';
import { Download, ImageIcon, Loader2, Music, Pin, UserPlus, Video } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { LibraryAsset } from '@/lib/data/assets';

/**
 * Everything generated, with the two things you can do with it.
 *
 * Reuse is the point of this screen, so the actions sit on the card rather than
 * behind a detail view: the decision "that face is right, use it" is made while
 * looking at the picture, and a screen that makes you navigate away to act on it
 * is a screen you stop using.
 */

export interface ReuseTargets {
  characters: Array<{ id: string; name: string; seriesTitle: string }>;
  shots: Array<{ id: string; label: string }>;
}

export function AssetGrid(props: {
  items: LibraryAsset[];
  kinds: string[];
  seriesOptions: Array<{ id: string; title: string }>;
  targets: ReuseTargets;
}) {
  const [kind, setKind] = useState('all');
  const [seriesId, setSeriesId] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      props.items.filter(
        (item) =>
          (kind === 'all' || item.kind === kind) &&
          (seriesId === 'all' || item.seriesId === seriesId),
      ),
    [props.items, kind, seriesId],
  );

  async function reuse(item: LibraryAsset, body: Record<string, unknown>) {
    setBusy(item.id);
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(item.id)}/reuse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The reuse layer's message is written for a person — "Mei Lin already
        // has the maximum of 5" — so it is shown rather than replaced.
        throw new Error(payload?.error?.message ?? 'That did not work.');
      }
      toast.success(payload?.data?.summary ?? 'Reused.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  if (props.items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Nothing generated yet. Clips, keyframes, character stills and finished cuts all land
          here as they are made.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Filter label="Kind" value={kind} onChange={setKind} options={[['all', 'All kinds'], ...props.kinds.map((k) => [k, k] as [string, string])]} />
        <Filter
          label="Series"
          value={seriesId}
          onChange={setSeriesId}
          options={[['all', 'All series'], ...props.seriesOptions.map((s) => [s.id, s.title] as [string, string])]}
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {visible.length} of {props.items.length}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {visible.map((item) => (
          <Card key={item.id} className="overflow-hidden">
            <Preview item={item} />
            <CardContent className="space-y-2 p-3">
              <div className="flex items-start gap-2">
                <KindIcon kind={item.kind} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={item.label}>
                    {item.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" title={item.seriesTitle}>
                    {item.seriesTitle}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {item.role === 'keyframe' && <Badge variant="secondary">keyframe</Badge>}
                {item.role === 'canonical' && <Badge variant="secondary">canonical</Badge>}
                {item.durationSeconds !== null && (
                  <Badge variant="outline">{item.durationSeconds}s</Badge>
                )}
                {item.costCents > 0 && (
                  <Badge variant="outline">{(item.costCents / 100).toFixed(2)}</Badge>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {item.url && (
                  <Button asChild size="sm" variant="outline">
                    <a href={item.url} download target="_blank" rel="noreferrer">
                      <Download className="size-3.5" />
                    </a>
                  </Button>
                )}

                {/* Only images can condition anything, so only images offer it. */}
                {item.kind === 'image' && props.targets.characters.length > 0 && (
                  <TargetPicker
                    icon={<UserPlus className="size-3.5" />}
                    title="Use as a character reference"
                    disabled={busy === item.id}
                    options={props.targets.characters.map((c) => ({
                      value: c.id,
                      label: `${c.name} · ${c.seriesTitle}`,
                    }))}
                    onPick={(characterId) =>
                      reuse(item, { target: 'character-reference', characterId })
                    }
                  />
                )}

                {item.kind === 'image' && props.targets.shots.length > 0 && (
                  <TargetPicker
                    icon={<Pin className="size-3.5" />}
                    title="Pin as a shot’s start frame"
                    disabled={busy === item.id}
                    options={props.targets.shots.map((s) => ({ value: s.id, label: s.label }))}
                    onPick={(shotId) => reuse(item, { target: 'shot-keyframe', shotId })}
                  />
                )}

                {busy === item.id && (
                  <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Preview({ item }: { item: LibraryAsset }) {
  if (!item.url) {
    return (
      <div className="flex aspect-[9/16] items-center justify-center bg-muted text-xs text-muted-foreground">
        {/* The row is there and the object is not. Said plainly rather than
            shown as a broken image, because it is a real state: pruning and
            manual bucket edits both produce it. */}
        file unavailable
      </div>
    );
  }

  if (item.kind === 'image') {
    return (
      /* eslint-disable-next-line @next/next/no-img-element --
         These are short-lived signed URLs on a storage host that next/image
         would need whitelisted per environment, and optimising a thumbnail
         that expires in an hour buys nothing. */
      <img src={item.url} alt={item.label} className="aspect-[9/16] w-full object-cover" />
    );
  }

  if (item.kind === 'video') {
    return <video src={item.url} controls preload="metadata" className="aspect-[9/16] w-full bg-black object-cover" />;
  }

  return (
    <div className="flex aspect-[9/16] items-center justify-center bg-muted p-3">
      <audio src={item.url} controls className="w-full" />
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === 'video' ? Video : kind === 'image' ? ImageIcon : Music;
  return <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

function Filter(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1 text-sm"
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A one-step picker: choose the destination and the action fires.
 *
 * Deliberately not a dialog with a confirm button. Reuse is cheap and
 * reversible — a character reference can be removed, a pin replaced — so a
 * confirmation step would cost more attention than the mistake it prevents.
 */
function TargetPicker(props: {
  icon: React.ReactNode;
  title: string;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        {props.icon}
      </Button>

      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 z-20 mb-1 max-h-56 w-56 overflow-y-auto',
            'rounded-md border border-border bg-popover p-1 shadow-md',
          )}
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">{props.title}</p>
          {props.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false);
                props.onPick(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
