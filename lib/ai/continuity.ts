/**
 * The recap that makes a series serialise.
 *
 * `generateScript` has accepted a `continuitySummary` since Phase 1, but nothing
 * ever built one — the parameter was dead, so episode 5 was written knowing only
 * the bible's one-line synopsis for episode 5. Characters could resolve a threat
 * that a previous episode had already resolved, or ignore a cliffhanger entirely.
 *
 * Pure and synchronous, so the recap can be asserted directly (Phase 5 AC #1)
 * rather than inferred from model output.
 */

/** What the composer needs from a previously written episode. */
export interface PriorEpisode {
  number: number;
  title: string;
  synopsis: string;
  hook: string | null;
  cliffhanger: string | null;
  /** The stored script, if the episode has been written. */
  script: { scenes?: Array<{ summary?: string }> } | null;
}

/**
 * Total character budget for the recap.
 *
 * A long series would otherwise grow this without limit and crowd out the
 * instructions that control episode length — the failure that made every early
 * script generation return no JSON at all. Older episodes are summarised more
 * tersely than recent ones, because what matters most for the next episode is
 * what just happened.
 */
export const CONTINUITY_BUDGET_CHARS = 1_800;

/** Per-episode allowance for the most recent episodes, which get more detail. */
const RECENT_EPISODE_CHARS = 400;
const OLDER_EPISODE_CHARS = 160;

/** How many trailing episodes count as "recent". */
const RECENT_WINDOW = 2;

/** Truncates at a word boundary, so the model never sees a severed word. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Collapses an episode's prose onto one line, then truncates it. */
function clip(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/**
 * What actually happened in an episode, preferring the written script over the
 * bible's plan: the script is what the audience saw, and the two diverge once a
 * human edits a scene.
 */
function whatHappened(episode: PriorEpisode, max: number): string {
  const summaries = (episode.script?.scenes ?? [])
    .map((s) => s.summary?.trim())
    .filter((s): s is string => Boolean(s));

  const body = summaries.length > 0 ? summaries.join(' Then: ') : episode.synopsis;
  return clip(body, max);
}

/**
 * Composes the recap for the episode about to be written.
 *
 * Episodes at or after `upcomingNumber` are ignored — writing episode 3 must not
 * be told what episode 4 does, or it will write towards an ending it has not
 * earned. Unwritten earlier episodes are ignored too: their bible synopsis is a
 * plan, not events, and presenting a plan as history makes the model contradict
 * itself later.
 *
 * Returns an empty string for episode 1, or when nothing prior has been written —
 * callers pass it through as-is, and the prompt omits the section entirely.
 */
export function composeContinuitySummary(
  priorEpisodes: readonly PriorEpisode[],
  upcomingNumber: number,
): string {
  const written = priorEpisodes
    .filter((e) => e.number < upcomingNumber)
    .filter((e) => Boolean(e.script) || e.synopsis.trim().length > 0)
    .sort((a, b) => a.number - b.number);

  if (written.length === 0) return '';

  const oldestRecent = Math.max(1, upcomingNumber - RECENT_WINDOW);

  const lines = written.map((episode) => {
    const allowance = episode.number >= oldestRecent ? RECENT_EPISODE_CHARS : OLDER_EPISODE_CHARS;
    const title = episode.title.trim() || `Episode ${episode.number}`;
    return `- Episode ${episode.number} ("${title}"): ${whatHappened(episode, allowance)}`;
  });

  /**
   * The immediately preceding cliffhanger, called out separately.
   *
   * Listing it inside the recap buried it, and the next episode would open on an
   * unrelated beat. Naming it as the thread to pick up is the whole mechanism by
   * which serialization holds.
   */
  const previous = written[written.length - 1]!;
  const cliffhanger = previous.cliffhanger?.trim();

  const parts = [lines.join('\n')];
  if (cliffhanger) {
    parts.push(
      `UNRESOLVED — episode ${previous.number} ended on this and episode ${upcomingNumber} must ` +
        `pick it up: ${clip(cliffhanger, 300)}`,
    );
  }

  // `truncate`, not `clip`: the line structure is the readable part of the recap
  // and collapsing it into one paragraph would undo the per-episode formatting.
  return truncate(parts.join('\n\n'), CONTINUITY_BUDGET_CHARS);
}
