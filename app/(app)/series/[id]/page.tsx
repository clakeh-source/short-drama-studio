import Link from 'next/link';
import { ChevronLeft, LayoutList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BibleWorkspace } from '@/components/series/bible-workspace';
import { requireUser } from '@/lib/auth';
import { loadSeries, parseBible } from '@/lib/data/series';
import { loadReferenceImagesForSeries } from '@/lib/data/characters';

export const dynamic = 'force-dynamic';

export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ generate?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { generate } = await searchParams;

  const detail = await loadSeries(user.id, id);
  const bible = parseBible(detail.series.bible);
  const referenceImages = await loadReferenceImagesForSeries(user.id, id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/series"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Series
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{detail.series.title}</h1>
          <Badge variant="outline">{detail.series.status}</Badge>
          <Link
            href={`/series/${id}/review`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-accent/40"
          >
            <LayoutList className="size-4" />
            Review board
          </Link>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.series.genre} · {detail.series.tone} · {detail.series.audience} ·{' '}
          {detail.series.episodeTargetCount} × {detail.series.episodeTargetSeconds}s
        </p>
      </div>

      <BibleWorkspace
        seriesId={detail.series.id}
        seriesTitle={detail.series.title}
        premise={detail.series.logline}
        episodeTargetSeconds={detail.series.episodeTargetSeconds}
        bible={bible}
        autoGenerate={generate === 'bible'}
        characters={detail.characters.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          description: c.description,
          appearancePrompt: c.appearancePrompt,
          voiceId: c.voiceId,
          referenceImages: (referenceImages.get(c.id) ?? []).map((image) => ({
            id: image.id,
            url: image.url,
            bytes: image.bytes,
            isCanonical: image.isCanonical,
          })),
        }))}
        episodes={detail.episodes.map((e) => ({
          id: e.id,
          number: e.number,
          title: e.title,
          synopsis: e.synopsis,
          status: e.status,
        }))}
      />
    </div>
  );
}
