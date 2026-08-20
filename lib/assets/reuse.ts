import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, withUserDb } from '@/lib/db';
import {
  assets,
  characterReferenceImages,
  characters,
  episodes,
  scenes,
  series,
  shots,
} from '@/lib/db/schema';
import {
  CANONICAL_REFERENCE_SET_SIZE,
  MAX_REFERENCE_IMAGES,
  resequence,
} from '@/lib/characters/references';
import { copyObject, deleteObjects, statObject } from '@/lib/storage';
import { log } from '@/lib/log';
import { resolveLibraryAsset } from '@/lib/data/assets';

/**
 * Using an asset you already have, somewhere else.
 *
 * The rule that shapes everything here: **reuse copies the object.** It would
 * be cheaper to point a second row at the same storage key, and it would be
 * wrong — `pruneShotVersions` deletes the objects of every take beyond the last
 * three, so a character whose reference still pointed at a shot's keyframe
 * would lose its face the fourth time that shot was regenerated. The failure
 * would surface as a broken image days later, with nothing linking it to the
 * regeneration that caused it.
 *
 * Copying also makes the cross-series case work. A character belongs to one
 * series; an object copied into that character's own prefix belongs to it
 * outright, so a still drawn for one show can establish a face in another
 * without either series holding a reference into the other's storage.
 */

export class ReuseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ReuseError';
  }
}

export interface ReuseResult {
  /** The new object, owned by the destination. */
  storagePath: string;
  bytes: number;
  /** What the destination now holds, for the toast. */
  summary: string;
}

/**
 * Adds a stored image to a character's reference set.
 *
 * This is the reuse that pays for itself: a keyframe already drawn for a shot,
 * or a still from another series' version of the same actor, becomes part of
 * what conditions every future clip that character appears in — instead of
 * paying an identity model to invent them again.
 */
export async function reuseAsCharacterReference(input: {
  userId: string;
  libraryAssetId: string;
  characterId: string;
}): Promise<ReuseResult> {
  const source = await resolveLibraryAsset(input.userId, input.libraryAssetId);
  if (!source) {
    // Indistinguishable from "not yours", deliberately: the id came from a
    // browser and this must not become a way to probe for other people's rows.
    throw new ReuseError('That asset could not be found.', 404);
  }

  const stat = await statObject(source.storagePath);
  if (!stat) {
    throw new ReuseError(
      'That asset is recorded but its file is missing, so it cannot be reused.',
      409,
    );
  }
  if (!stat.contentType.startsWith('image/')) {
    // A clip conditions nothing. Refused here rather than at the provider,
    // where it would look like a model failure.
    throw new ReuseError('Only an image can become a character reference.', 400);
  }

  const destination = await withUserDb(input.userId, async (tx) => {
    const [row] = await tx
      .select({ id: characters.id, name: characters.name, seriesId: series.id })
      .from(characters)
      .innerJoin(series, eq(series.id, characters.seriesId))
      .where(eq(characters.id, input.characterId));
    return row ?? null;
  });

  if (!destination) throw new ReuseError('That character could not be found.', 404);

  const existing = await withUserDb(input.userId, (tx) =>
    tx
      .select({
        id: characterReferenceImages.id,
        orderIndex: characterReferenceImages.orderIndex,
      })
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, input.characterId))
      .orderBy(asc(characterReferenceImages.orderIndex)),
  );

  if (existing.length >= MAX_REFERENCE_IMAGES) {
    throw new ReuseError(
      `${destination.name} already has the maximum of ${MAX_REFERENCE_IMAGES} reference images. ` +
        'Remove one first.',
      409,
    );
  }

  const orderIndex = existing.length;
  const extension = stat.contentType === 'image/png' ? 'png' : 'jpg';

  // Its own object under the character's prefix, so deleting the character
  // removes it and pruning the source shot does not.
  const copy = await copyObject(source.storagePath, {
    bucket: 'references',
    path: `${input.userId}/${input.characterId}/reused-${randomUUID()}.${extension}`,
  });

  /**
   * From here the object exists and nothing points at it yet.
   *
   * Any failure below has to take the copy with it. An object with no row is
   * invisible — it does not appear in this library, it is not deleted with the
   * character, and it shows up only as a line on a storage bill months later.
   * The last time this project leaked objects this way it took a dedicated
   * sweeper and 510 deletions to find out.
   */
  let inserted: { id: string } | undefined;
  try {
    [inserted] = await withUserDb(input.userId, (tx) =>
      tx
        .insert(characterReferenceImages)
        .values({
          characterId: input.characterId,
          storagePath: copy.storagePath,
          contentType: stat.contentType,
          bytes: copy.bytes || stat.bytes,
          orderIndex,
          // Canonical status is not decided here — `recanonicalise` owns that
          // rule for every path that adds a still, and duplicating it is how the
          // two drift apart.
          isCanonical: false,
        })
        .returning({ id: characterReferenceImages.id }),
    );
  } catch (error) {
    await deleteObjects([copy.storagePath]).catch(() => {});
    throw error;
  }

  if (!inserted) {
    await deleteObjects([copy.storagePath]).catch(() => {});
    throw new ReuseError('Could not attach that image to the character.', 500);
  }

  const canonical = await recanonicalise(input.userId, input.characterId);

  log.info('asset reused as a character reference', {
    userId: input.userId,
    operation: 'asset.reuse.character_reference',
    characterId: input.characterId,
    from: source.origin,
    crossSeries: source.seriesId !== destination.seriesId,
    orderIndex,
    canonical,
  });

  return {
    storagePath: copy.storagePath,
    bytes: copy.bytes || stat.bytes,
    summary:
      `Added to ${destination.name} as reference ${orderIndex + 1}` +
      (canonical >= CANONICAL_REFERENCE_SET_SIZE
        ? `. ${destination.name} now has a canonical set.`
        : `. ${CANONICAL_REFERENCE_SET_SIZE - canonical} more needed for a canonical set.`),
  };
}

/**
 * Pins a stored image as a shot's start frame.
 *
 * The other half of reuse, and the one that changes what generation *does*: a
 * pinned keyframe is used instead of drawing a new one, so a frame you already
 * like — from a take you liked, or from another episode entirely — becomes the
 * thing the clip is built from. It also saves the image the job would otherwise
 * have paid for.
 *
 * Pinned rather than merely present, because the job already writes a keyframe
 * asset per attempt. Reusing whichever one happened to be there would silently
 * stop retries from redrawing, which is a different decision that nobody made.
 */
export async function reuseAsShotKeyframe(input: {
  userId: string;
  libraryAssetId: string;
  shotId: string;
}): Promise<ReuseResult> {
  const source = await resolveLibraryAsset(input.userId, input.libraryAssetId);
  if (!source) throw new ReuseError('That asset could not be found.', 404);

  const stat = await statObject(source.storagePath);
  if (!stat) {
    throw new ReuseError(
      'That asset is recorded but its file is missing, so it cannot be reused.',
      409,
    );
  }
  if (!stat.contentType.startsWith('image/')) {
    // A start frame is a frame. Refused here rather than at Kling, which would
    // report it as an unhelpful 422 halfway through a run.
    throw new ReuseError('Only an image can be a shot’s start frame.', 400);
  }

  const destination = await withUserDb(input.userId, async (tx) => {
    const [row] = await tx
      .select({
        shotId: shots.id,
        version: shots.version,
        orderIndex: shots.orderIndex,
        episodeId: episodes.id,
        episodeNumber: episodes.number,
        seriesId: series.id,
      })
      .from(shots)
      .innerJoin(scenes, eq(scenes.id, shots.sceneId))
      .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(eq(shots.id, input.shotId));
    return row ?? null;
  });

  if (!destination) throw new ReuseError('That shot could not be found.', 404);

  const extension = stat.contentType === 'image/png' ? 'png' : 'jpg';
  const copy = await copyObject(source.storagePath, {
    bucket: 'references',
    path:
      `${input.userId}/${destination.episodeId}/keyframes/${input.shotId}/` +
      `pinned-${randomUUID()}.${extension}`,
  });

  let supersededPaths: string[] = [];

  try {
    supersededPaths = await withUserDb(input.userId, async (tx) => {
      /**
       * One pin per shot.
       *
       * Replacing rather than accumulating: "the start frame" is singular, and
       * a second pin would leave the job choosing between two images with no
       * rule for which. The old object goes too — it was a copy this feature
       * made, so nothing else points at it.
       */
      const previous = await tx
        .select({ id: assets.id, storagePath: assets.storagePath })
        .from(assets)
        .where(and(eq(assets.shotId, input.shotId), sql`${assets.meta}->>'pinned' = 'true'`));

      if (previous.length > 0) {
        await tx.delete(assets).where(
          inArray(
            assets.id,
            previous.map((row) => row.id),
          ),
        );
      }

      await tx.insert(assets).values({
        shotId: input.shotId,
        episodeId: destination.episodeId,
        kind: 'image',
        provider: 'reuse',
        version: destination.version,
        status: 'ready',
        storagePath: copy.storagePath,
        // Reuse is free by construction: the image was already paid for when it
        // was generated, and charging again would double-count it against the
        // spend cap.
        costCents: 0,
        meta: {
          ai_generated: true,
          role: 'keyframe',
          pinned: true,
          reusedFrom: input.libraryAssetId,
          bytes: copy.bytes || stat.bytes,
        },
      });

      return previous
        .map((row) => row.storagePath)
        .filter((path): path is string => Boolean(path));
    });
  } catch (error) {
    await deleteObjects([copy.storagePath]).catch(() => {});
    throw error;
  }

  /**
   * The superseded object goes only after the new row is committed.
   *
   * Deleting inside the transaction would leave the old pin's row restored by a
   * rollback and its object already gone — a row pointing at nothing, which is
   * a broken image with no way back. This ordering can leave an unreferenced
   * object if the process dies here, and that is the recoverable direction:
   * `pnpm orphans` finds it.
   */
  if (supersededPaths.length > 0) await deleteObjects(supersededPaths).catch(() => {});

  log.info('asset pinned as a shot start frame', {
    userId: input.userId,
    operation: 'asset.reuse.shot_keyframe',
    shotId: input.shotId,
    from: source.origin,
    crossSeries: source.seriesId !== destination.seriesId,
    superseded: supersededPaths.length,
  });

  return {
    storagePath: copy.storagePath,
    bytes: copy.bytes || stat.bytes,
    summary:
      `Pinned as the start frame for episode ${destination.episodeNumber}, ` +
      `shot ${destination.orderIndex + 1}. It will be used instead of drawing a new keyframe.`,
  };
}

/**
 * The image a shot has been told to start from, if someone pinned one.
 *
 * Read by the generation job before it spends anything on a keyframe.
 */
export async function pinnedShotKeyframe(
  shotId: string,
): Promise<{ storagePath: string; assetId: string } | null> {
  const [row] = await db()
    .select({ id: assets.id, storagePath: assets.storagePath })
    .from(assets)
    .where(
      and(
        eq(assets.shotId, shotId),
        eq(assets.status, 'ready'),
        sql`${assets.meta}->>'pinned' = 'true'`,
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(1);

  return row?.storagePath ? { storagePath: row.storagePath, assetId: row.id } : null;
}

/**
 * Re-applies the canonical rule after the set has changed.
 *
 * The rule itself is `resequence` in lib/characters/references.ts, which the
 * upload path already uses. Restating it here would mean adding a still by
 * reuse and adding one by upload could disagree about what a character's face
 * is — and the disagreement would only show as drift in a finished clip.
 */
async function recanonicalise(userId: string, characterId: string): Promise<number> {
  return withUserDb(userId, async (tx) => {
    const rows = await tx
      .select({
        id: characterReferenceImages.id,
        orderIndex: characterReferenceImages.orderIndex,
        isCanonical: characterReferenceImages.isCanonical,
      })
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, characterId))
      .orderBy(asc(characterReferenceImages.orderIndex));

    for (const next of resequence(rows)) {
      const before = rows.find((row) => row.id === next.id);
      // Only write what actually changes: reuse usually appends, which leaves
      // every existing row already correct.
      if (before?.orderIndex === next.orderIndex && before.isCanonical === next.isCanonical) {
        continue;
      }
      await tx
        .update(characterReferenceImages)
        .set({ orderIndex: next.orderIndex, isCanonical: next.isCanonical })
        .where(eq(characterReferenceImages.id, next.id));
    }

    return rows.length;
  });
}
