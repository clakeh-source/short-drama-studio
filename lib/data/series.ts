import 'server-only';

import { and, asc, eq, lt } from 'drizzle-orm';
import { withUserDb } from '@/lib/db';
import { characters, episodes, series } from '@/lib/db/schema';
import type { Character, Episode, Series } from '@/lib/db/schema';
import { bibleSchema, scriptSchema, type Bible, type Script } from '@/lib/ai/schemas';
import { composeContinuitySummary, type PriorEpisode } from '@/lib/ai/continuity';
import { notFound } from '@/lib/api/handler';
import { getTtsProvider } from '@/lib/providers';
import { log } from '@/lib/log';
import { assignDefaultVoices } from '@/lib/voices';

/**
 * Starting voices for a fresh cast. The catalogue lookup is a provider call, so
 * a TTS outage must not block saving a bible — the assignment is a convenience,
 * and an unassigned character produces a clear "pick a voice" message later
 * rather than a corrupt series.
 */
async function defaultVoiceAssignment(
  cast: ReadonlyArray<{ name: string; role: string }>,
): Promise<Map<string, string>> {
  try {
    return assignDefaultVoices(cast, await getTtsProvider().listVoices());
  } catch (error) {
    log.warn('could not list voices; leaving the cast unassigned', {
      operation: 'voices.list.failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * Reads and writes for the series aggregate.
 *
 * Every query runs through `withUserDb`, so none of them carry a `user_id`
 * filter — RLS scopes them. A missing row and someone else's row are therefore
 * the same thing here, and both surface as 404.
 */

export interface SeriesDetail {
  series: Series;
  characters: Character[];
  episodes: Episode[];
}

export async function loadSeries(userId: string, seriesId: string): Promise<SeriesDetail> {
  return withUserDb(userId, async (tx) => {
    const [row] = await tx.select().from(series).where(eq(series.id, seriesId));
    if (!row) throw notFound('Series not found');

    const [cast, eps] = await Promise.all([
      tx.select().from(characters).where(eq(characters.seriesId, seriesId)).orderBy(asc(characters.createdAt)),
      tx.select().from(episodes).where(eq(episodes.seriesId, seriesId)).orderBy(asc(episodes.number)),
    ]);

    return { series: row, characters: cast, episodes: eps };
  });
}

export interface EpisodeDetail {
  episode: Episode;
  series: Series;
  characters: Character[];
}

export async function loadEpisode(userId: string, episodeId: string): Promise<EpisodeDetail> {
  return withUserDb(userId, async (tx) => {
    const [episode] = await tx.select().from(episodes).where(eq(episodes.id, episodeId));
    if (!episode) throw notFound('Episode not found');

    const [seriesRow] = await tx.select().from(series).where(eq(series.id, episode.seriesId));
    if (!seriesRow) throw notFound('Series not found');

    const cast = await tx
      .select()
      .from(characters)
      .where(eq(characters.seriesId, episode.seriesId))
      .orderBy(asc(characters.createdAt));

    return { episode, series: seriesRow, characters: cast };
  });
}

/**
 * The recap of everything already written in this series before `upcomingNumber`.
 *
 * Read through `withUserDb` like every other request-side query, so RLS scopes
 * it and no `user_id` filter is needed here.
 */
export async function loadContinuitySummary(
  userId: string,
  seriesId: string,
  upcomingNumber: number,
): Promise<string> {
  const rows = await withUserDb(userId, (tx) =>
    tx
      .select({
        number: episodes.number,
        title: episodes.title,
        synopsis: episodes.synopsis,
        hook: episodes.hook,
        cliffhanger: episodes.cliffhanger,
        script: episodes.script,
      })
      .from(episodes)
      .where(and(eq(episodes.seriesId, seriesId), lt(episodes.number, upcomingNumber)))
      .orderBy(asc(episodes.number)),
  );

  return composeContinuitySummary(
    rows.map((r) => ({ ...r, script: r.script as PriorEpisode['script'] })),
    upcomingNumber,
  );
}

export async function loadEpisodeByNumber(
  userId: string,
  seriesId: string,
  number: number,
): Promise<EpisodeDetail> {
  const detail = await loadSeries(userId, seriesId);
  const episode = detail.episodes.find((e) => e.number === number);
  if (!episode) throw notFound(`Episode ${number} not found`);
  return { episode, series: detail.series, characters: detail.characters };
}

/* -------------------------------------------------------------------------- */
/* Parsing stored JSON                                                        */
/* -------------------------------------------------------------------------- */

/** `series.bible` is jsonb; re-validate rather than trusting what is on disk. */
export function parseBible(value: unknown): Bible | null {
  if (!value) return null;
  const parsed = bibleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseScript(value: unknown): Script | null {
  if (!value) return null;
  const parsed = scriptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* Persisting a generated bible                                               */
/* -------------------------------------------------------------------------- */

/**
 * Writes the bible, its cast and its episode stubs in one transaction.
 *
 * Regenerating replaces the cast wholesale but **preserves existing episodes**:
 * an episode that already has a script must not lose it because the bible was
 * re-rolled. Only missing episode numbers are inserted.
 */
export async function persistBible(
  userId: string,
  seriesId: string,
  bible: Bible,
): Promise<void> {
  await withUserDb(userId, async (tx) => {
    await tx
      .update(series)
      .set({
        title: bible.title,
        logline: bible.logline,
        bible,
        status: 'active',
      })
      .where(eq(series.id, seriesId));

    // A voice the user picked is a deliberate choice; carry it across a re-roll
    // rather than letting the wholesale cast replacement throw it away.
    const priorVoices = new Map(
      (
        await tx
          .select({ name: characters.name, voiceId: characters.voiceId })
          .from(characters)
          .where(eq(characters.seriesId, seriesId))
      )
        .filter((c): c is { name: string; voiceId: string } => Boolean(c.voiceId))
        .map((c) => [c.name, c.voiceId]),
    );

    const defaults = await defaultVoiceAssignment(bible.characters);

    await tx.delete(characters).where(eq(characters.seriesId, seriesId));
    await tx.insert(characters).values(
      bible.characters.map((c) => ({
        seriesId,
        name: c.name,
        role: c.role,
        description: c.description,
        appearancePrompt: c.appearance_prompt,
        voiceId: priorVoices.get(c.name) ?? defaults.get(c.name) ?? null,
      })),
    );

    const existing = await tx
      .select({ number: episodes.number })
      .from(episodes)
      .where(eq(episodes.seriesId, seriesId));
    const known = new Set(existing.map((e) => e.number));

    const missing = bible.episodes.filter((e) => !known.has(e.number));
    if (missing.length > 0) {
      await tx.insert(episodes).values(
        missing.map((e) => ({
          seriesId,
          number: e.number,
          title: e.title,
          synopsis: e.synopsis,
        })),
      );
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Persisting a generated script                                              */
/* -------------------------------------------------------------------------- */

export async function persistScript(
  userId: string,
  episodeId: string,
  script: Script,
): Promise<void> {
  await withUserDb(userId, (tx) =>
    tx
      .update(episodes)
      .set({
        script,
        hook: script.hook,
        cliffhanger: script.cliffhanger,
        status: 'scripted',
      })
      .where(eq(episodes.id, episodeId)),
  );
}
