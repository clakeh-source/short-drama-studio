'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckSquare, Download, Film, Loader2, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { episodeFilename } from '@/lib/filenames';
import type { LibraryEpisode } from '@/lib/data/library';

/** Sequential downloads need a beat between them or the browser drops all but one. */
const DOWNLOAD_GAP_MS = 700;

export function LibraryGrid(props: { episodes: LibraryEpisode[]; statuses: string[] }) {
  const [status, setStatus] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

  const visible = useMemo(
    () => (status === 'all' ? props.episodes : props.episodes.filter((e) => e.status === status)),
    [props.episodes, status],
  );

  const downloadable = visible.filter((e) => e.hasVideo);
  const selectedDownloadable = downloadable.filter((e) => selected.has(e.episodeId));

  function toggle(episodeId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      downloadable.every((e) => prev.has(e.episodeId))
        ? new Set()
        : new Set(downloadable.map((e) => e.episodeId)),
    );
  }

  /**
   * Downloads each selection in turn.
   *
   * Not a server-side zip: that would stream every episode's bytes back through
   * the app just to repackage files the browser can already fetch directly from
   * signed storage URLs. The trade-off is that the browser shows one download per
   * file, which is also what makes the filenames meaningful.
   */
  async function downloadSelected() {
    if (selectedDownloadable.length === 0) return;
    setDownloading(true);

    try {
      for (const [index, episode] of selectedDownloadable.entries()) {
        if (!episode.downloadUrl) continue;

        const anchor = document.createElement('a');
        anchor.href = episode.downloadUrl;
        anchor.download = episodeFilename(episode);
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        if (index < selectedDownloadable.length - 1) {
          await new Promise((r) => setTimeout(r, DOWNLOAD_GAP_MS));
        }
      }

      toast.success(
        selectedDownloadable.length === 1
          ? 'Download started.'
          : `${selectedDownloadable.length} downloads started.`,
      );
    } finally {
      setDownloading(false);
    }
  }

  if (props.episodes.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <Film className="size-8 text-muted-foreground" />
          <h2 className="font-medium">Nothing here yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Episodes appear here as soon as a series has them — rendered or not.
          </p>
          <Button asChild className="mt-2">
            <Link href="/series/new">Start a series</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------ toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          <FilterChip active={status === 'all'} onClick={() => setStatus('all')}>
            All <span className="opacity-60">{props.episodes.length}</span>
          </FilterChip>
          {props.statuses.map((option) => (
            <FilterChip
              key={option}
              active={status === option}
              onClick={() => setStatus(option)}
            >
              {option}{' '}
              <span className="opacity-60">
                {props.episodes.filter((e) => e.status === option).length}
              </span>
            </FilterChip>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {downloadable.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              {downloadable.every((e) => selected.has(e.episodeId)) ? (
                <CheckSquare className="size-4" />
              ) : (
                <Square className="size-4" />
              )}
              Select all rendered
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={downloadSelected}
            disabled={downloading || selectedDownloadable.length === 0}
          >
            {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {selectedDownloadable.length > 0
              ? `Download ${selectedDownloadable.length}`
              : 'Download'}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No {status} episodes.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((episode) => (
            <LibraryTile
              key={episode.episodeId}
              episode={episode}
              selected={selected.has(episode.episodeId)}
              onToggle={() => toggle(episode.episodeId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryTile(props: {
  episode: LibraryEpisode;
  selected: boolean;
  onToggle: () => void;
}) {
  const { episode } = props;

  return (
    <li>
      <Card className={cn('overflow-hidden', props.selected && 'ring-2 ring-primary')}>
        {/*
          A 9:16 box, centred in a full-width well. The ratio matches the
          deliverable so the grid reads as vertical video; the well stops the tile
          from either stretching to the card's width or leaving bare space beside
          itself.
        */}
        <div className="relative mx-auto flex h-72 w-full items-center justify-center bg-muted">
          {episode.hasVideo && episode.downloadUrl ? (
            /**
             * The rendered file is its own thumbnail: `preload="metadata"` fetches
             * only enough to paint the first frame, so the grid costs a few KB per
             * tile rather than a whole episode, and there is no separate poster
             * pipeline to keep in step with the renders.
             */
            <video
              src={episode.downloadUrl}
              preload="metadata"
              muted
              playsInline
              controls
              className="aspect-[9/16] h-full bg-black"
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Film className="size-6" />
              <span className="text-xs">Not rendered yet</span>
            </div>
          )}

          {episode.hasVideo ? (
            <button
              type="button"
              onClick={props.onToggle}
              aria-label={props.selected ? 'Deselect episode' : 'Select episode'}
              aria-pressed={props.selected}
              className="absolute left-2 top-2 rounded bg-background/80 p-1 backdrop-blur hover:bg-background"
            >
              {props.selected ? (
                <CheckSquare className="size-4 text-primary" />
              ) : (
                <Square className="size-4" />
              )}
            </button>
          ) : null}
        </div>

        <CardContent className="space-y-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground" title={episode.seriesTitle}>
                {episode.seriesTitle}
              </p>
              <p className="truncate font-medium" title={episode.title}>
                {episode.number}. {episode.title || `Episode ${episode.number}`}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              {episode.status}
            </Badge>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {episode.durationSeconds ? `${episode.durationSeconds}s` : '—'}
              {episode.renderCount > 1 ? ` · ${episode.renderCount} renders` : ''}
            </span>
            <Link
              href={`/series/${episode.seriesId}/episodes/${episode.number}/export`}
              className="hover:text-foreground hover:underline"
            >
              Open
            </Link>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function FilterChip(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs capitalize transition-colors',
        props.active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {props.children}
    </button>
  );
}
