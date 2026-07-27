import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ExportPanel } from '@/components/export/export-panel';
import { requireUser } from '@/lib/auth';
import { notFound } from '@/lib/api/handler';
import { loadEpisodeByNumber } from '@/lib/data/series';
import { buildRendersPayload } from '@/lib/data/render';
import { CAPTION_PRESETS } from '@/lib/captions';

export const dynamic = 'force-dynamic';

export default async function ExportPage({
  params,
}: {
  params: Promise<{ id: string; number: string }>;
}) {
  const user = await requireUser();
  const { id, number } = await params;

  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber)) throw notFound('Episode not found');

  const { episode, series } = await loadEpisodeByNumber(user.id, id, parsedNumber);
  const payload = await buildRendersPayload(user.id, episode.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/series/${id}/episodes/${parsedNumber}/generate`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Generation
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Export</h1>
          <Badge variant="outline">{episode.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {episode.title || `Episode ${parsedNumber}`} — assemble the clips into one vertical MP4.
        </p>
      </div>

      <ExportPanel
        episodeId={episode.id}
        seriesId={series.id}
        captionStyleId={series.captionStyleId}
        captionStyles={Object.values(CAPTION_PRESETS).map((s) => ({ id: s.id, label: s.label }))}
        initial={payload}
      />
    </div>
  );
}
