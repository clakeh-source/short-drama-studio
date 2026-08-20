import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { characterReferenceImages, characters, series } from '@/lib/db/schema';
import {
  confirmReferenceImages,
  createCharacter,
  deleteCharacter,
  issueReferenceUploads,
  loadCanonicalReferenceSets,
  loadCharacter,
  removeReferenceImages,
} from '@/lib/data/characters';
import { listObjects, referenceImagePrefix, statObject } from '@/lib/storage';
import { purgeUserObjects } from './support/storage';
import { MAX_REFERENCE_IMAGE_BYTES } from '@/lib/characters/references';

/**
 * Phase 2 acceptance, end to end against the real object store.
 *
 * The whole point of the design is that the bytes never pass through this
 * server, which means nothing about it can be proven with a mock: the upload URL
 * has to actually work, the object has to actually land, and the server has to
 * actually read back what arrived. So this suite talks to real Supabase Storage
 * and a real database, and skips when either is unconfigured.
 *
 * Everything it creates is torn down in `afterAll`, including the bucket
 * objects — a leaked object here would be indistinguishable from the leak the
 * delete path exists to prevent.
 */
const configured = Boolean(
  process.env.DATABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** A real 1x1 PNG. Small, but genuinely a PNG — the store sniffs the bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const userId = crypto.randomUUID();
let seriesId: string;

/** Uploads a buffer through a signed ticket, exactly as the browser does. */
async function putThroughTicket(
  uploadUrl: string,
  body: Buffer,
  contentType: string,
): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  });
}

/** Creates a character and uploads `count` stills to it, the full round trip. */
async function characterWithStills(name: string, count: number) {
  const character = await createCharacter(userId, seriesId, { name });

  if (count > 0) {
    const tickets = await issueReferenceUploads(
      userId,
      character.id,
      Array.from({ length: count }, (_, i) => ({
        filename: `${i}.png`,
        contentType: 'image/png',
        bytes: PNG.byteLength,
      })),
    );

    for (const ticket of tickets) {
      const response = await putThroughTicket(ticket.uploadUrl, PNG, 'image/png');
      expect(response.ok, `upload of ${ticket.filename} failed`).toBe(true);
    }

    await confirmReferenceImages(
      userId,
      character.id,
      tickets.map((t) => t.storagePath),
    );
  }

  return character;
}

describe.skipIf(!configured)('character reference images, against real storage', () => {
  beforeAll(async () => {
    const [row] = await db()
      .insert(series)
      .values({ userId, title: 'Refs: storage round trip', logline: '' })
      .returning({ id: series.id });
    seriesId = row!.id;
  });

  afterAll(async () => {
    // Delete through the application path so any object it fails to clean up
    // shows here rather than silently accumulating in the bucket.
    const cast = await db().select().from(characters).where(eq(characters.seriesId, seriesId));
    for (const member of cast) {
      await deleteCharacter(userId, member.id).catch(() => {});
    }

    /**
     * A backstop after the application path above.
     *
     * `deleteCharacter` is the thing under test here, so the loop is deliberate
     * — a leak it fails to clean shows up as a real failure elsewhere. But this
     * suite also uploads through signed tickets that are never confirmed, and
     * those objects have no row to be deleted by.
     */
    await purgeUserObjects(userId);

    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('AC #1 — uploads land in the bucket and the record reflects them', async () => {
    const character = await createCharacter(userId, seriesId, { name: 'Mei Lin' });

    const [ticket] = await issueReferenceUploads(userId, character.id, [
      { filename: 'mei.png', contentType: 'image/png', bytes: PNG.byteLength },
    ]);

    // The path is the server's choice, never the client's.
    expect(ticket!.storagePath).toContain(`${userId}/${character.id}/`);
    expect(ticket!.uploadUrl).toMatch(/^https?:\/\//);

    // Nothing is recorded yet — the URL is only a capability to write.
    expect((await loadCharacter(userId, character.id)).referenceImages).toHaveLength(0);

    const upload = await putThroughTicket(ticket!.uploadUrl, PNG, 'image/png');
    expect(upload.ok).toBe(true);

    const result = await confirmReferenceImages(userId, character.id, [ticket!.storagePath]);
    expect(result.added).toHaveLength(1);

    const detail = await loadCharacter(userId, character.id);
    expect(detail.referenceImages).toHaveLength(1);

    const [image] = detail.referenceImages;
    expect(image!.storagePath).toBe(ticket!.storagePath);
    // Measured from the stored object, not copied from the request.
    expect(image!.bytes).toBe(PNG.byteLength);
    expect(image!.contentType).toBe('image/png');
    expect(image!.url).toMatch(/^https?:\/\//);
  });

  it('AC #2 — refuses a wrong content type with a message that names it', async () => {
    const character = await createCharacter(userId, seriesId, { name: 'Wrong type' });

    await expect(
      issueReferenceUploads(userId, character.id, [
        { filename: 'clip.mov', contentType: 'video/quicktime', bytes: 1000 },
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/video\/quicktime.*JPEG or PNG/s),
    });
  });

  it('AC #2 — refuses an oversized declaration with a message that names the limit', async () => {
    const character = await createCharacter(userId, seriesId, { name: 'Too big' });

    await expect(
      issueReferenceUploads(userId, character.id, [
        { filename: 'huge.png', contentType: 'image/png', bytes: MAX_REFERENCE_IMAGE_BYTES + 1 },
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/10\.0MB/),
    });
  });

  it('AC #2 — the bucket refuses an oversized body even on a valid ticket', async () => {
    // The declaration check above can be bypassed by lying about `bytes`. This
    // is the layer that cannot be: the browser holds a real signed URL and PUTs
    // 11MB at it anyway.
    const character = await createCharacter(userId, seriesId, { name: 'Liar' });

    const [ticket] = await issueReferenceUploads(userId, character.id, [
      { filename: 'small.png', contentType: 'image/png', bytes: 1000 },
    ]);

    const oversized = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1024, 0);
    const response = await putThroughTicket(ticket!.uploadUrl, oversized, 'image/png');

    expect(response.ok).toBe(false);
    expect(await statObject(ticket!.storagePath)).toBeNull();

    // And with nothing stored, the confirm refuses rather than recording a row
    // for an object that is not there.
    await expect(
      confirmReferenceImages(userId, character.id, [ticket!.storagePath]),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/did not complete/) });
  });

  it('refuses to attach a path belonging to a different character', async () => {
    const mine = await createCharacter(userId, seriesId, { name: 'Mine' });
    const theirs = await characterWithStills('Theirs', 1);

    const [stolen] = await db()
      .select()
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, theirs.id));

    await expect(
      confirmReferenceImages(userId, mine.id, [stolen!.storagePath]),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/does not belong to this character/),
    });

    // And the other character keeps its still.
    expect((await loadCharacter(userId, theirs.id)).referenceImages).toHaveLength(1);
  });

  it('flags the canonical set only once the third still arrives', async () => {
    const character = await characterWithStills('Canonical', 2);

    let detail = await loadCharacter(userId, character.id);
    expect(detail.referenceImages.map((i) => i.isCanonical)).toEqual([false, false]);
    expect(await loadCanonicalReferenceSets(userId, [character.id])).toEqual(new Map());

    const [ticket] = await issueReferenceUploads(userId, character.id, [
      { filename: 'third.png', contentType: 'image/png', bytes: PNG.byteLength },
    ]);
    await putThroughTicket(ticket!.uploadUrl, PNG, 'image/png');
    await confirmReferenceImages(userId, character.id, [ticket!.storagePath]);

    detail = await loadCharacter(userId, character.id);
    expect(detail.referenceImages.map((i) => i.isCanonical)).toEqual([true, true, true]);

    // Which is what Phase 4 reads to decide image-to-video vs text-to-video.
    const sets = await loadCanonicalReferenceSets(userId, [character.id]);
    expect(sets.get(character.id)).toHaveLength(3);
  });

  it('removing a still closes the gap and drops the canonical set', async () => {
    const character = await characterWithStills('Shrinking', 3);

    const before = await loadCharacter(userId, character.id);
    expect(before.referenceImages.map((i) => i.isCanonical)).toEqual([true, true, true]);

    await removeReferenceImages(userId, character.id, [before.referenceImages[1]!.id]);

    const after = await loadCharacter(userId, character.id);
    expect(after.referenceImages.map((i) => i.orderIndex)).toEqual([0, 1]);
    expect(after.referenceImages.map((i) => i.isCanonical)).toEqual([false, false]);

    // The removed object is gone from the bucket, not just from the table.
    expect(await statObject(before.referenceImages[1]!.storagePath)).toBeNull();
  });

  it('AC #3 — deleting a character empties its prefix in the bucket', async () => {
    const character = await characterWithStills('Doomed', 3);

    const prefix = referenceImagePrefix({ userId, characterId: character.id });

    const before = await listObjects('references', prefix);
    expect(before).toHaveLength(3);
    for (const object of before) {
      expect(object.contentType).toBe('image/png');
    }

    await deleteCharacter(userId, character.id);

    const after = await listObjects('references', prefix);
    expect(after).toHaveLength(0);

    // And the rows went with the character.
    const rows = await db()
      .select()
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, character.id));
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(configured)('character reference storage suite', () => {
  it('is skipped without a database and Supabase credentials', () => {
    console.warn(
      'Skipped: set DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, ' +
        'then run `pnpm db:migrate && pnpm db:buckets`.',
    );
    expect(configured).toBe(false);
  });
});
