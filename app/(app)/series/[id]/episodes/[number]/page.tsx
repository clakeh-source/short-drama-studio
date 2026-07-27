import Link from 'next/link';
import { ChevronLeft, Clapperboard } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScriptEditor } from '@/components/series/script-editor';
import { requireUser } from '@/lib/auth';
import { loadEpisodeByNumber, parseScript } from '@/lib/data/series';
import { notFound } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ id: string; number: string }>;
}) {
  const user = await requireUser();
  const { id, number } = await params;

  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber)) throw notFound('Episode not found');

  const { episode, series, characters } = await loadEpisodeByNumber(user.id, id, parsedNumber);
  const script = parseScript(episode.script);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/series/${id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {series.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            <span className="font-mono text-muted-foreground">
              {String(episode.number).padStart(2, '0')}
            </span>{' '}
            {episode.title}
          </h1>
          <Badge variant="outline">{episode.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{episode.synopsis}</p>
        {script ? (
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href={`/series/${id}/episodes/${parsedNumber}/storyboard`}>
              <Clapperboard />
              Storyboard
            </Link>
          </Button>
        ) : null}
      </div>

      <ScriptEditor
        episodeId={episode.id}
        episodeNumber={episode.number}
        episodeTitle={episode.title}
        synopsis={episode.synopsis}
        targetSeconds={series.episodeTargetSeconds}
        castNames={characters.map((c) => c.name)}
        script={script}
      />
    </div>
  );
}
