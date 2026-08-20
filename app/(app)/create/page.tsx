import { RunWorkspace } from '@/components/review/run-workspace';
import { requireUser } from '@/lib/auth';
import { listRuns } from '@/lib/data/runs';

/**
 * The single workspace.
 *
 * Reopens whatever run is still going rather than always starting fresh: a run
 * takes twenty minutes and nobody sits watching it, so arriving here mid-run
 * should show the film being made, not an empty prompt box.
 */
export const dynamic = 'force-dynamic';

export default async function CreatePage() {
  const user = await requireUser();

  const recent = await listRuns(user.id, 5);

  /**
   * A run in flight if there is one, otherwise the last one there was.
   *
   * The fallback is the whole point. This used to reopen only unfinished runs,
   * so the moment a film *completed* the page reverted to an empty prompt box:
   * you waited twenty minutes, it worked, and the screen that made it showed no
   * trace of it. The film was in the Library, which you would only know if
   * someone told you.
   *
   * Reopening the finished run instead shows the video, what it cost, and a
   * "Make another" button that clears it deliberately.
   */
  const active =
    recent.find((run) => ['pending', 'running', 'awaiting_gate'].includes(run.status)) ??
    recent[0];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A prompt becomes a finished film. You can stop it at two points along the way.
        </p>
      </div>

      <RunWorkspace initialRunId={active?.id ?? null} />
    </div>
  );
}
