import { requireUser } from '@/lib/auth';
import { loadLibrary, totalRuntimeSeconds } from '@/lib/data/library';
import { LibraryGrid } from '@/components/library/library-grid';

export const metadata = { title: 'Library · Short Drama Studio' };
export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const user = await requireUser();
  const library = await loadLibrary(user.id);
  const runtime = totalRuntimeSeconds(library);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {library.episodes.length === 0
            ? 'Every episode across all your series will appear here.'
            : `${library.episodes.length} ${
                library.episodes.length === 1 ? 'episode' : 'episodes'
              } across ${library.seriesCount} ${
                library.seriesCount === 1 ? 'series' : 'series'
              } · ${library.renderedCount} rendered · ${formatRuntime(runtime)} of video`}
        </p>
      </div>

      <LibraryGrid episodes={library.episodes} statuses={library.statuses} />
    </div>
  );
}

function formatRuntime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
