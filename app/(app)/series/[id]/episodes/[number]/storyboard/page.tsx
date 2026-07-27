import { Suspense } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StoryboardWorkspace } from '@/components/storyboard/storyboard-workspace';
import { requireUser } from '@/lib/auth';
import { notFound } from '@/lib/api/handler';
import { parseBible, parseScript } from '@/lib/data/series';
import { loadStoryboardPage } from '@/lib/data/storyboard';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';

export const dynamic = 'force-dynamic';

/**
 * The storyboard is the heaviest route in the app and the one Phase 5 AC #4
 * measures, so it streams: the shell below is flushed immediately and the board
 * arrives when its queries finish.
 *
 * That split matters because roughly 550ms of this request is unavoidable
 * latency to services in another region — about 365ms for the auth middleware's
 * round trip to Supabase Auth, then five queries at ~27ms each. Rendering the
 * page as one blocking unit meant the browser saw nothing at all for that whole
 * time; the header, breadcrumb and skeleton now paint while it is still in
 * flight.
 */
export default async function StoryboardPage({
  params,
}: {
  params: Promise<{ id: string; number: string }>;
}) {
  const { id, number } = await params;

  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber)) throw notFound('Episode not found');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/series/${id}/episodes/${parsedNumber}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Episode {parsedNumber}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Storyboard</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Every shot becomes one generated clip. Read the prompts before you spend anything.
        </p>
      </div>

      <Suspense fallback={<BoardSkeleton />}>
        <Board seriesId={id} episodeNumber={parsedNumber} />
      </Suspense>
    </div>
  );
}

async function Board({ seriesId, episodeNumber }: { seriesId: string; episodeNumber: number }) {
  const user = await requireUser();

  // One transaction for the whole board — see `loadStoryboardPage`.
  const board = await loadStoryboardPage(user.id, seriesId, episodeNumber);
  const { episode, series } = board;

  const bible = parseBible(series.bible);
  const script = parseScript(episode.script);
  const allShots = board.scenes.flatMap((s) => s.shots);

  const estimate =
    allShots.length > 0
      ? estimateEpisodeCost(allShots, getVideoProvider(), getTtsProvider())
      : null;

  return (
    <>
      {/* The status badge belongs with the heading, but it needs the episode. */}
      <div className="-mt-3">
        <Badge variant="outline">{episode.status}</Badge>
      </div>

      <StoryboardWorkspace
        episodeId={episode.id}
        episodeNumber={episode.number}
        episodeHref={`/series/${seriesId}/episodes/${episodeNumber}`}
        targetSeconds={series.episodeTargetSeconds}
        hasScript={Boolean(script)}
        styleSuffix={bible?.visual_style ?? null}
        /*
         * One copy for the whole board. Every shot in a series stores the same
         * negative prompt, so sending it per shot was 4 KB of the payload to say
         * one thing twenty times.
         */
        negativePrompt={allShots[0]?.negativePrompt ?? null}
        cast={board.characters.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          appearancePrompt: c.appearancePrompt,
        }))}
        scenes={board.scenes.map(({ scene, shots }) => ({
          id: scene.id,
          orderIndex: scene.orderIndex,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          shots: shots.map((s) => ({
            id: s.id,
            orderIndex: s.orderIndex,
            durationSeconds: s.durationSeconds,
            camera: s.camera,
            action: s.action,
            dialogue: s.dialogue,
            speakerCharacterId: s.speakerCharacterId,
            characterIds: s.characterIds,
            promptOverride: s.promptOverride,
            status: s.status,
          })),
        }))}
        estimate={estimate}
      />
    </>
  );
}

/** Sized to the real board, so the streamed content does not shift the page. */
function BoardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border border-border p-3">
            <Skeleton className="h-40 w-24 shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
