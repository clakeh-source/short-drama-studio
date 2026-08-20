import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { withUserDb } from '@/lib/db';
import {
  assets,
  characterReferenceImages,
  characters,
  episodes,
  renders,
  scenes,
  series,
  shots,
} from '@/lib/db/schema';
import { signedUrls } from '@/lib/storage';

/**
 * Everything this user has ever generated, in one place.
 *
 * Four things produce stored objects and none of them knew about each other: a
 * shot's clips and keyframes (`assets`), a character's reference stills
 * (`character_reference_images`), an episode's finished cuts (`renders`), and
 * voice tracks (`assets` again, under a different kind). They live in different
 * tables because they have different owners and lifetimes, which is right — but
 * it left no answer to "what have I made", and no way to use a picture you
 * already paid for in a shot that needs one.
 *
 * This is the read that unifies them. It is deliberately a *view*: nothing here
 * owns an object, so nothing here deletes one. Reuse copies (see
 * `lib/assets/reuse.ts`), because these rows have owners who will eventually
 * prune them.
 */

/** Where an asset came from, which decides what can be done with it. */
export type AssetOrigin = 'shot' | 'character' | 'render';

export interface LibraryAsset {
  /** Stable across reads: `${origin}:${row id}`, since ids are only unique per table. */
  id: string;
  origin: AssetOrigin;
  kind: 'video' | 'image' | 'voice' | 'music' | 'sfx';
  storagePath: string;
  /** Signed for preview. Absent when the object could not be signed. */
  url: string | null;
  bytes: number | null;
  durationSeconds: number | null;
  costCents: number;
  createdAt: string;

  seriesId: string;
  seriesTitle: string;
  /** Null for a character still, which belongs to the series rather than an episode. */
  episodeId: string | null;
  episodeNumber: number | null;
  shotId: string | null;
  /** Human-readable provenance: "S1E2 · shot 4 · keyframe", "Mei Lin · still 2". */
  label: string;
  /** `keyframe` distinguishes a shot's start frame from its clip; both are shot images. */
  role: string | null;
  characterId: string | null;
  characterName: string | null;
}

export interface AssetLibrary {
  items: LibraryAsset[];
  /** Distinct values actually present, so a filter never offers an empty result. */
  kinds: string[];
  seriesOptions: Array<{ id: string; title: string }>;
  totalBytes: number;
  totalCostCents: number;
}

export interface AssetFilters {
  kind?: string;
  seriesId?: string;
  origin?: AssetOrigin;
}

/** Preview URLs are short-lived; the page is re-read on navigation anyway. */
const PREVIEW_TTL_SECONDS = 60 * 60;

export async function loadAssetLibrary(
  userId: string,
  filters: AssetFilters = {},
): Promise<AssetLibrary> {
  const rows = await withUserDb(userId, async (tx) => {
    /**
     * Three reads rather than one union.
     *
     * The shapes genuinely differ — a character still has no episode, a render
     * has no shot — and a union would need every column nullable and every
     * caller to remember which combination is possible. RLS scopes each of
     * them to this user through its own owner policy, so the joins here are for
     * labels, not for permission.
     */
    const shotAssets = await tx
      .select({
        id: assets.id,
        kind: assets.kind,
        storagePath: assets.storagePath,
        durationSeconds: assets.durationSeconds,
        costCents: assets.costCents,
        createdAt: assets.createdAt,
        meta: assets.meta,
        shotId: assets.shotId,
        shotOrder: shots.orderIndex,
        sceneOrder: scenes.orderIndex,
        episodeId: episodes.id,
        episodeNumber: episodes.number,
        seriesId: series.id,
        seriesTitle: series.title,
      })
      .from(assets)
      .innerJoin(episodes, eq(episodes.id, assets.episodeId))
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .leftJoin(shots, eq(shots.id, assets.shotId))
      .leftJoin(scenes, eq(scenes.id, shots.sceneId))
      // Only what actually landed. A failed or in-flight asset has no object to
      // show and nothing to reuse.
      .where(eq(assets.status, 'ready'))
      .orderBy(desc(assets.createdAt));

    const stills = await tx
      .select({
        id: characterReferenceImages.id,
        storagePath: characterReferenceImages.storagePath,
        bytes: characterReferenceImages.bytes,
        orderIndex: characterReferenceImages.orderIndex,
        isCanonical: characterReferenceImages.isCanonical,
        createdAt: characterReferenceImages.createdAt,
        characterId: characters.id,
        characterName: characters.name,
        seriesId: series.id,
        seriesTitle: series.title,
      })
      .from(characterReferenceImages)
      .innerJoin(characters, eq(characters.id, characterReferenceImages.characterId))
      .innerJoin(series, eq(series.id, characters.seriesId))
      .orderBy(desc(characterReferenceImages.createdAt));

    const cuts = await tx
      .select({
        id: renders.id,
        storagePath: renders.storagePath,
        durationSeconds: renders.durationSeconds,
        costCents: renders.costCents,
        createdAt: renders.createdAt,
        episodeId: episodes.id,
        episodeNumber: episodes.number,
        episodeTitle: episodes.title,
        seriesId: series.id,
        seriesTitle: series.title,
      })
      .from(renders)
      .innerJoin(episodes, eq(episodes.id, renders.episodeId))
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(eq(renders.status, 'ready'))
      .orderBy(desc(renders.createdAt));

    return { shotAssets, stills, cuts };
  });

  const items: LibraryAsset[] = [];

  for (const row of rows.shotAssets) {
    if (!row.storagePath) continue;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const role = typeof meta.role === 'string' ? meta.role : null;

    items.push({
      id: `shot:${row.id}`,
      origin: 'shot',
      kind: row.kind,
      storagePath: row.storagePath,
      url: null,
      bytes: typeof meta.bytes === 'number' ? meta.bytes : null,
      durationSeconds: row.durationSeconds,
      costCents: row.costCents,
      createdAt: row.createdAt.toISOString(),
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      episodeId: row.episodeId,
      episodeNumber: row.episodeNumber,
      shotId: row.shotId,
      label: shotLabel(row.episodeNumber, row.sceneOrder, row.shotOrder, row.kind, role),
      role,
      characterId: null,
      characterName: null,
    });
  }

  for (const row of rows.stills) {
    items.push({
      id: `character:${row.id}`,
      origin: 'character',
      kind: 'image',
      storagePath: row.storagePath,
      url: null,
      bytes: row.bytes,
      durationSeconds: null,
      // Stills are charged on the character, not per image, so attributing a
      // number here would double-count against the usage page.
      costCents: 0,
      createdAt: row.createdAt.toISOString(),
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      episodeId: null,
      episodeNumber: null,
      shotId: null,
      label: `${row.characterName} · still ${row.orderIndex + 1}${
        row.isCanonical ? ' (canonical)' : ''
      }`,
      role: row.isCanonical ? 'canonical' : 'still',
      characterId: row.characterId,
      characterName: row.characterName,
    });
  }

  for (const row of rows.cuts) {
    if (!row.storagePath) continue;
    items.push({
      id: `render:${row.id}`,
      origin: 'render',
      kind: 'video',
      storagePath: row.storagePath,
      url: null,
      bytes: null,
      durationSeconds: row.durationSeconds,
      costCents: row.costCents ?? 0,
      createdAt: row.createdAt.toISOString(),
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      episodeId: row.episodeId,
      episodeNumber: row.episodeNumber,
      shotId: null,
      label: `Episode ${row.episodeNumber}${row.episodeTitle ? ` · ${row.episodeTitle}` : ''} · full cut`,
      role: 'render',
      characterId: null,
      characterName: null,
    });
  }

  // Options come from the unfiltered set, so narrowing to one series does not
  // remove the control you would use to get back out of it.
  const kinds = [...new Set(items.map((i) => i.kind))].sort();
  const seriesOptions = [
    ...new Map(items.map((i) => [i.seriesId, { id: i.seriesId, title: i.seriesTitle }])).values(),
  ].sort((a, b) => a.title.localeCompare(b.title));

  const filtered = items.filter(
    (item) =>
      (!filters.kind || item.kind === filters.kind) &&
      (!filters.seriesId || item.seriesId === filters.seriesId) &&
      (!filters.origin || item.origin === filters.origin),
  );

  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // One signing round trip for the whole page rather than one per card.
  const signed = await signedUrls(
    filtered.map((i) => i.storagePath),
    PREVIEW_TTL_SECONDS,
  );
  for (const item of filtered) item.url = signed.get(item.storagePath) ?? null;

  return {
    items: filtered,
    kinds,
    seriesOptions,
    totalBytes: filtered.reduce((sum, i) => sum + (i.bytes ?? 0), 0),
    totalCostCents: filtered.reduce((sum, i) => sum + i.costCents, 0),
  };
}

function shotLabel(
  episodeNumber: number,
  sceneOrder: number | null,
  shotOrder: number | null,
  kind: string,
  role: string | null,
): string {
  const where =
    sceneOrder !== null && shotOrder !== null
      ? `E${episodeNumber} · scene ${sceneOrder + 1} · shot ${shotOrder + 1}`
      : `E${episodeNumber}`;

  const what = role === 'keyframe' ? 'keyframe' : kind === 'voice' ? 'voice' : kind;
  return `${where} · ${what}`;
}

/**
 * Resolves a library id back to the row it names, with the user's ownership
 * re-checked rather than assumed.
 *
 * The id travels through the browser, so it is an input like any other: the
 * lookup runs under RLS and returns null for anything this user does not own,
 * which is what keeps "reuse asset X" from being a way to read someone else's
 * storage path.
 */
export async function resolveLibraryAsset(
  userId: string,
  libraryId: string,
): Promise<{ origin: AssetOrigin; storagePath: string; seriesId: string } | null> {
  const [origin, rowId] = libraryId.split(':');
  if (!origin || !rowId) return null;

  return withUserDb(userId, async (tx) => {
    if (origin === 'shot') {
      const [row] = await tx
        .select({ storagePath: assets.storagePath, seriesId: series.id })
        .from(assets)
        .innerJoin(episodes, eq(episodes.id, assets.episodeId))
        .innerJoin(series, eq(series.id, episodes.seriesId))
        .where(and(eq(assets.id, rowId), eq(assets.status, 'ready')));
      return row?.storagePath
        ? { origin: 'shot' as const, storagePath: row.storagePath, seriesId: row.seriesId }
        : null;
    }

    if (origin === 'character') {
      const [row] = await tx
        .select({
          storagePath: characterReferenceImages.storagePath,
          seriesId: series.id,
        })
        .from(characterReferenceImages)
        .innerJoin(characters, eq(characters.id, characterReferenceImages.characterId))
        .innerJoin(series, eq(series.id, characters.seriesId))
        .where(eq(characterReferenceImages.id, rowId));
      return row
        ? { origin: 'character' as const, storagePath: row.storagePath, seriesId: row.seriesId }
        : null;
    }

    if (origin === 'render') {
      const [row] = await tx
        .select({ storagePath: renders.storagePath, seriesId: series.id })
        .from(renders)
        .innerJoin(episodes, eq(episodes.id, renders.episodeId))
        .innerJoin(series, eq(series.id, episodes.seriesId))
        .where(eq(renders.id, rowId));
      return row?.storagePath
        ? { origin: 'render' as const, storagePath: row.storagePath, seriesId: row.seriesId }
        : null;
    }

    return null;
  });
}
