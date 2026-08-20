import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { badRequest, notFound } from '@/lib/api/handler';
import { withUserDb, type Transaction } from '@/lib/db';
import { characterReferenceImages, characters, series } from '@/lib/db/schema';
import type { Character, CharacterReferenceImage } from '@/lib/db/schema';
import {
  extensionFor,
  resequence,
  validateStoredObject,
  validateUploadBatch,
  type DeclaredUpload,
} from '@/lib/characters/references';
import {
  createUploadUrl,
  deleteObjects,
  referenceImagePath,
  signedUrls,
  statObject,
  type UploadTicket,
} from '@/lib/storage';
import { log } from '@/lib/log';

/**
 * Characters and their reference stills.
 *
 * Every query runs through `withUserDb`, so none of them filter on `user_id` —
 * RLS scopes them, and someone else's character is indistinguishable from one
 * that does not exist. Both surface as 404.
 *
 * Storage calls are deliberately kept *outside* the database transactions here.
 * A `withUserDb` block holds a pooled connection for its whole duration, and
 * signing or statting an object is a network round trip to another service;
 * doing that inside the transaction would tie up a connection on someone else's
 * latency.
 */

export interface ReferenceImageView {
  id: string;
  storagePath: string;
  contentType: string;
  bytes: number;
  orderIndex: number;
  isCanonical: boolean;
  /** Short-lived signed URL, or null when the object cannot be signed. */
  url: string | null;
}

export interface CharacterDetail {
  character: Character;
  referenceImages: ReferenceImageView[];
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function readCharacter(
  userId: string,
  characterId: string,
): Promise<{ character: Character; rows: CharacterReferenceImage[] }> {
  return withUserDb(userId, async (tx) => {
    const [character] = await tx.select().from(characters).where(eq(characters.id, characterId));
    if (!character) throw notFound('Character not found');

    const rows = await referenceRows(tx, characterId);
    return { character, rows };
  });
}

function referenceRows(tx: Transaction, characterId: string) {
  return tx
    .select()
    .from(characterReferenceImages)
    .where(eq(characterReferenceImages.characterId, characterId))
    .orderBy(asc(characterReferenceImages.orderIndex));
}

/** A character with playable URLs for each of its stills. */
export async function loadCharacter(
  userId: string,
  characterId: string,
): Promise<CharacterDetail> {
  const { character, rows } = await readCharacter(userId, characterId);
  return { character, referenceImages: await withSignedUrls(rows) };
}

async function withSignedUrls(
  rows: readonly CharacterReferenceImage[],
): Promise<ReferenceImageView[]> {
  const signed = await signedUrls(rows.map((r) => r.storagePath));

  return rows.map((row) => ({
    id: row.id,
    storagePath: row.storagePath,
    contentType: row.contentType,
    bytes: row.bytes,
    orderIndex: row.orderIndex,
    isCanonical: row.isCanonical,
    url: signed.get(row.storagePath) ?? null,
  }));
}

/**
 * Every character's stills for one series, keyed by character id, with signed
 * URLs ready to render.
 *
 * One query and one batched signing call for the whole cast — the series page
 * renders every character at once, and a per-character round trip would be five
 * or six of each.
 */
export async function loadReferenceImagesForSeries(
  userId: string,
  seriesId: string,
): Promise<Map<string, ReferenceImageView[]>> {
  const rows = await withUserDb(userId, (tx) =>
    tx
      .select({ image: characterReferenceImages })
      .from(characterReferenceImages)
      .innerJoin(characters, eq(characters.id, characterReferenceImages.characterId))
      .where(eq(characters.seriesId, seriesId))
      .orderBy(asc(characterReferenceImages.orderIndex)),
  );

  const views = await withSignedUrls(rows.map((r) => r.image));

  const byCharacter = new Map<string, ReferenceImageView[]>();
  rows.forEach((row, index) => {
    const view = views[index]!;
    const existing = byCharacter.get(row.image.characterId);
    if (existing) existing.push(view);
    else byCharacter.set(row.image.characterId, [view]);
  });

  return byCharacter;
}

/**
 * The stills fed to Kling for a set of characters, keyed by character id.
 *
 * This is the read Phase 4 makes on every image-to-video call, which is why
 * `is_canonical` is a stored flag with its own partial index rather than a slice
 * computed here. Characters with no canonical set are absent from the map, not
 * present with an empty array — the caller's branch is "did this character
 * contribute references at all".
 */
export async function loadCanonicalReferenceSets(
  userId: string,
  characterIds: readonly string[],
): Promise<Map<string, CharacterReferenceImage[]>> {
  if (characterIds.length === 0) return new Map();

  const rows = await withUserDb(userId, (tx) =>
    tx
      .select()
      .from(characterReferenceImages)
      .where(
        and(
          inArray(characterReferenceImages.characterId, [...characterIds]),
          eq(characterReferenceImages.isCanonical, true),
        ),
      )
      .orderBy(asc(characterReferenceImages.orderIndex)),
  );

  const byCharacter = new Map<string, CharacterReferenceImage[]>();
  for (const row of rows) {
    const existing = byCharacter.get(row.characterId);
    if (existing) existing.push(row);
    else byCharacter.set(row.characterId, [row]);
  }

  return byCharacter;
}

/* -------------------------------------------------------------------------- */
/* Create and delete                                                          */
/* -------------------------------------------------------------------------- */

export interface NewCharacterInput {
  name: string;
  role?: string;
  description?: string;
  appearancePrompt?: string;
  voiceId?: string | null;
}

export async function createCharacter(
  userId: string,
  seriesId: string,
  input: NewCharacterInput,
): Promise<Character> {
  return withUserDb(userId, async (tx) => {
    // RLS would refuse the insert anyway, but it refuses with a 42501 that reads
    // like a server fault. Checking first turns it into an honest 404.
    const [owner] = await tx.select().from(series).where(eq(series.id, seriesId));
    if (!owner) throw notFound('Series not found');

    const [row] = await tx
      .insert(characters)
      .values({
        seriesId,
        name: input.name,
        role: input.role ?? '',
        description: input.description ?? '',
        appearancePrompt: input.appearancePrompt ?? '',
        voiceId: input.voiceId ?? null,
      })
      .returning();

    return row!;
  });
}

/**
 * Removes a character and every still it owns, from storage as well as the
 * database.
 *
 * Storage goes first on purpose. If the database delete then fails, the rows
 * survive pointing at objects that are gone — visible in the UI as a broken
 * image, and fixable by deleting again. The other order fails the other way: the
 * rows disappear and the objects stay, untracked, and nothing will ever look for
 * them again.
 */
export async function deleteCharacter(userId: string, characterId: string): Promise<void> {
  const { rows } = await readCharacter(userId, characterId);

  if (rows.length > 0) {
    await deleteObjects(rows.map((r) => r.storagePath));
  }

  await withUserDb(userId, (tx) => tx.delete(characters).where(eq(characters.id, characterId)));

  log.info('character deleted', {
    userId,
    characterId,
    operation: 'character.delete',
    referenceImages: rows.length,
  });
}

/* -------------------------------------------------------------------------- */
/* Reference stills                                                           */
/* -------------------------------------------------------------------------- */

export interface IssuedUpload extends UploadTicket {
  filename: string;
}

/**
 * Mints one upload URL per declared file.
 *
 * The paths are chosen here, never by the caller: a signed upload URL is a
 * capability to write one object, so handing out a URL for a client-supplied
 * path would let anyone with an account write anywhere in the bucket.
 *
 * Everything validated at this point is a *claim* — the client's word for what
 * it is about to send. It is checked here to fail fast and cheaply; the check
 * that actually binds happens in `confirmReferenceImages`, after the bytes have
 * landed.
 */
export async function issueReferenceUploads(
  userId: string,
  characterId: string,
  files: readonly DeclaredUpload[],
): Promise<IssuedUpload[]> {
  const { rows } = await readCharacter(userId, characterId);

  const check = validateUploadBatch(files, rows.length);
  if (!check.ok) throw badRequest(check.message);

  return Promise.all(
    files.map(async (file) => {
      const ticket = await createUploadUrl({
        bucket: 'references',
        path: referenceImagePath({
          userId,
          characterId,
          objectId: randomUUID(),
          extension: extensionFor(file.contentType),
        }),
      });

      return { ...ticket, filename: file.filename };
    }),
  );
}

export interface ConfirmResult {
  added: ReferenceImageView[];
  /** Uploads that were rejected after inspection, and why. Their objects are gone. */
  rejected: Array<{ storagePath: string; reason: string }>;
}

/**
 * Records uploads that have already landed in storage.
 *
 * The bytes never passed through this server, so every one of them is inspected
 * here — actual size, actual content type, straight from the store. A client
 * that declared `image/png` and then PUT a 40MB video gets its object deleted
 * and a 400, not a row.
 */
export async function confirmReferenceImages(
  userId: string,
  characterId: string,
  storagePaths: readonly string[],
): Promise<ConfirmResult> {
  const { rows } = await readCharacter(userId, characterId);

  const expectedPrefix = `${userId}/${characterId}/`;
  const known = new Set(rows.map((r) => r.storagePath));

  const rejected: Array<{ storagePath: string; reason: string }> = [];
  const accepted: Array<{ storagePath: string; bytes: number; contentType: string }> = [];

  for (const storagePath of new Set(storagePaths)) {
    // The path has to be one this server could have issued. Without this, a
    // caller could point a confirm at any object in the bucket and attach
    // someone else's image to their own character.
    if (!storagePath.includes(expectedPrefix)) {
      rejected.push({ storagePath, reason: 'That path does not belong to this character.' });
      continue;
    }

    if (known.has(storagePath)) {
      rejected.push({ storagePath, reason: 'That image is already attached.' });
      continue;
    }

    const stored = await statObject(storagePath);
    const check = validateStoredObject(stored);

    if (!check.ok) {
      rejected.push({ storagePath, reason: check.message });
      continue;
    }

    accepted.push({ storagePath, bytes: stored!.bytes, contentType: stored!.contentType });
  }

  // A rejected upload is already sitting in the bucket. Nothing will reference
  // it, so it has to be removed here or it leaks.
  if (rejected.length > 0) {
    await deleteObjects(
      rejected.filter((r) => r.reason !== 'That image is already attached.').map((r) => r.storagePath),
    );
  }

  if (accepted.length === 0) {
    throw badRequest(
      rejected[0]?.reason ?? 'None of those uploads could be attached.',
      { rejected },
    );
  }

  const room = validateUploadBatch(
    accepted.map((a) => ({ filename: a.storagePath, ...a })),
    rows.length,
  );
  if (!room.ok) {
    await deleteObjects(accepted.map((a) => a.storagePath));
    throw badRequest(room.message);
  }

  const added = await withUserDb(userId, async (tx) => {
    const inserted = await tx
      .insert(characterReferenceImages)
      .values(
        accepted.map((file, index) => ({
          characterId,
          storagePath: file.storagePath,
          contentType: file.contentType,
          bytes: file.bytes,
          orderIndex: rows.length + index,
        })),
      )
      .returning();

    await syncCanonicalSet(tx, characterId);
    return inserted;
  });

  log.info('reference images attached', {
    userId,
    characterId,
    operation: 'character.references.add',
    added: added.length,
    rejected: rejected.length,
  });

  const refreshed = await withUserDb(userId, (tx) => referenceRows(tx, characterId));
  const addedIds = new Set(added.map((r) => r.id));

  return {
    added: await withSignedUrls(refreshed.filter((r) => addedIds.has(r.id))),
    rejected,
  };
}

/** Detaches stills and removes their stored objects. */
export async function removeReferenceImages(
  userId: string,
  characterId: string,
  imageIds: readonly string[],
): Promise<{ removed: number }> {
  const { rows } = await readCharacter(userId, characterId);

  const targets = rows.filter((row) => imageIds.includes(row.id));
  if (targets.length === 0) throw notFound('No matching reference images');

  // Storage first, for the same reason as `deleteCharacter`.
  await deleteObjects(targets.map((t) => t.storagePath));

  await withUserDb(userId, async (tx) => {
    await tx.delete(characterReferenceImages).where(
      inArray(
        characterReferenceImages.id,
        targets.map((t) => t.id),
      ),
    );
    await syncCanonicalSet(tx, characterId);
  });

  log.info('reference images removed', {
    userId,
    characterId,
    operation: 'character.references.remove',
    removed: targets.length,
  });

  return { removed: targets.length };
}

/**
 * Renumbers a character's stills and re-flags the canonical set.
 *
 * Run after every add and every remove. Removing the second of four stills
 * leaves positions 0, 2, 3; left alone those gaps would eventually push a
 * surviving row past the CHECK's upper bound, and "the first three" would stop
 * meaning what it says.
 */
async function syncCanonicalSet(tx: Transaction, characterId: string): Promise<void> {
  const rows = await referenceRows(tx, characterId);

  for (const target of resequence(rows)) {
    const current = rows.find((r) => r.id === target.id)!;
    if (current.orderIndex === target.orderIndex && current.isCanonical === target.isCanonical) {
      continue;
    }

    await tx
      .update(characterReferenceImages)
      .set({ orderIndex: target.orderIndex, isCanonical: target.isCanonical })
      .where(eq(characterReferenceImages.id, target.id));
  }
}
