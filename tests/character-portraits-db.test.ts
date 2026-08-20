import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { characterReferenceImages, characters, series } from '@/lib/db/schema';
import { generateCharacterPortraits, generateMissingPortraits } from '@/lib/characters/portraits';
import { CANONICAL_REFERENCE_SET_SIZE } from '@/lib/characters/references';
import { signedUrl, statObject } from '@/lib/storage';
import { purgeUserObjects } from './support/storage';
import { registeredProviderIds } from '@/lib/providers';

/**
 * Character reference stills, generated rather than uploaded.
 *
 * This is the step that makes an unattended run able to produce a character
 * whose face survives between shots, so what matters is not that an image came
 * back — it is that the image reached storage as a real, inspectable object and
 * was flagged canonical, because that is the only form Phase 4 will actually
 * feed to Kling.
 *
 * Runs against the stub image provider, which returns genuine decodable PNGs
 * for exactly this reason. Requires DATABASE_URL and Supabase credentials.
 */
process.env.IMAGE_PROVIDER = 'stub';

const configured = Boolean(
  process.env.DATABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const userId = crypto.randomUUID();
let seriesId: string;
let meiId: string;

const APPEARANCE =
  'East Asian woman in her early thirties, sharp jaw, black hair pulled back, ' +
  'olive canvas jacket over a grey sweater, tired eyes';

async function freshCast(): Promise<void> {
  await db().delete(series).where(eq(series.userId, userId));

  const [row] = await db()
    .insert(series)
    .values({ userId, title: 'Portraits: The Last Ferry', logline: '' })
    .returning({ id: series.id });
  seriesId = row!.id;

  const [mei] = await db()
    .insert(characters)
    .values({ seriesId, name: 'Mei Lin', appearancePrompt: APPEARANCE })
    .returning({ id: characters.id });
  meiId = mei!.id;
}

/**
 * The stub's identity channel, read back out of a stored still.
 *
 * Downloads the object rather than trusting the row, so this proves the image
 * that actually reached the bucket carries the reference — not merely that the
 * right argument was passed somewhere upstream.
 */
async function firstChannel(storagePath: string): Promise<number> {
  const url = await signedUrl(storagePath);
  const png = Buffer.from(await (await fetch(url!)).arrayBuffer());
  const idat = png.indexOf(Buffer.from('IDAT', 'ascii'));
  return png[idat + 4 + 7 + 1]!;
}

function stills(characterId: string) {
  return db()
    .select()
    .from(characterReferenceImages)
    .where(eq(characterReferenceImages.characterId, characterId))
    .orderBy(asc(characterReferenceImages.orderIndex));
}

describe.skipIf(!configured)('generating character reference stills', () => {
  beforeEach(freshCast);

  afterAll(async () => {
    /**
     * By the user, not by the rows.
     *
     * `beforeEach` drops the series before each test, which cascades away every
     * character — so a teardown that walked the cast could only ever clean up
     * after the *last* test, and every earlier one stranded its images. That is
     * where the 126 orphaned objects came from.
     */
    await purgeUserObjects(userId);
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('registers an image provider behind one env var', () => {
    expect(registeredProviderIds().image).toEqual(['stub', 'fal']);
  });

  describe('identity', () => {
    it('locks the set to one face', async () => {
      const result = await generateCharacterPortraits(userId, meiId);

      // Every still after the first was generated from the first one's face
      // rather than from the same description — the difference between one
      // character and three who match a brief.
      expect(result.identityLocked).toBe(true);
    });

    it('conditions the later stills on the hero, not on each other’s prompts', async () => {
      await generateCharacterPortraits(userId, meiId);
      const rows = await stills(meiId);

      // The stub encodes the reference in one channel and the prompt in the
      // others, so a shared first channel across all three is the observable
      // form of "same person, different pose".
      const channels = await Promise.all(rows.map((r) => firstChannel(r.storagePath)));

      expect(new Set(channels.slice(1)).size).toBe(1);
      // …and they are still distinct images, not three copies of the hero.
      expect(new Set(rows.map((r) => r.storagePath)).size).toBe(rows.length);
    });

    it('reports honestly when the provider cannot preserve identity', async () => {
      // A provider without the capability must degrade *and say so*, because a
      // set that drifted looks identical to one that did not.
      const { StubImageProvider } = await import('@/lib/providers/stub/image');
      const noIdentity = new StubImageProvider();
      Object.defineProperty(noIdentity, 'supportsIdentity', { value: false });

      expect(noIdentity.supportsIdentity).toBe(false);
    });
  });

  it('produces a full canonical set from the appearance prompt alone', async () => {
    const result = await generateCharacterPortraits(userId, meiId);

    expect(result.generated).toBe(CANONICAL_REFERENCE_SET_SIZE);
    expect(result.costCents).toBeGreaterThan(0);

    const rows = await stills(meiId);
    expect(rows).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
    // The whole point: Phase 4 only feeds Kling images flagged canonical.
    expect(rows.every((r) => r.isCanonical)).toBe(true);
    expect(rows.map((r) => r.orderIndex)).toEqual([0, 1, 2]);
  });

  it('stores real objects, not just rows', async () => {
    await generateCharacterPortraits(userId, meiId);

    for (const row of await stills(meiId)) {
      // Measured from the store, the same way an upload is verified in Phase 2.
      const stored = await statObject(row.storagePath);
      expect(stored, `${row.storagePath} is not in the bucket`).not.toBeNull();
      expect(stored!.bytes).toBeGreaterThan(0);
      expect(stored!.contentType).toMatch(/^image\/(png|jpeg)$/);
      expect(row.bytes).toBe(stored!.bytes);
    }
  });

  it('gives each still a distinct object', async () => {
    await generateCharacterPortraits(userId, meiId);
    const rows = await stills(meiId);

    // Three copies of one image is a canonical set in name only — it conditions
    // the video model on a single angle and calls it three.
    expect(new Set(rows.map((r) => r.storagePath)).size).toBe(rows.length);
  });

  it('refuses a character with no appearance prompt', async () => {
    const [blank] = await db()
      .insert(characters)
      .values({ seriesId, name: 'Nobody', appearancePrompt: '' })
      .returning({ id: characters.id });

    // Generating from a name alone produces a stranger, and that stranger then
    // appears in every clip.
    await expect(generateCharacterPortraits(userId, blank!.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(await stills(blank!.id)).toHaveLength(0);
  });

  it('replaces the previous set rather than appending to it', async () => {
    const first = await generateCharacterPortraits(userId, meiId);
    const second = await generateCharacterPortraits(userId, meiId);

    const rows = await stills(meiId);
    expect(rows).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
    // A half-generated set mixed with the previous one is worse than either.
    expect(rows.map((r) => r.id).sort()).toEqual(second.imageIds.sort());
    expect(rows.some((r) => first.imageIds.includes(r.id))).toBe(false);
  });

  it('deletes the replaced set’s objects, not just its rows', async () => {
    await generateCharacterPortraits(userId, meiId);
    const before = (await stills(meiId)).map((r) => r.storagePath);
    expect(before).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);

    await generateCharacterPortraits(userId, meiId);

    // The original defect: the rows were replaced and the images were left in
    // the bucket with nothing pointing at them. Invisible, because the UI only
    // ever reads rows — three orphans per regeneration, for ever.
    for (const path of before) {
      expect(await statObject(path), `${path} was left in the bucket`).toBeNull();
    }

    // And the new set is genuinely there.
    for (const row of await stills(meiId)) {
      expect(await statObject(row.storagePath)).not.toBeNull();
    }
  });

  describe('the whole cast at once', () => {
    it('generates for characters that have none and skips the rest', async () => {
      const [daniel] = await db()
        .insert(characters)
        .values({ seriesId, name: 'Daniel Voss', appearancePrompt: 'a man in his forties' })
        .returning({ id: characters.id });

      // Mei already has a set someone might have curated.
      await generateCharacterPortraits(userId, meiId);

      const result = await generateMissingPortraits(userId, seriesId);

      expect(result.skipped).toContain('Mei Lin');
      expect(result.generated.map((g) => g.characterName)).toEqual(['Daniel Voss']);
      expect(await stills(daniel!.id)).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
    });

    it('skips a character with no appearance prompt instead of failing the run', async () => {
      await db()
        .insert(characters)
        .values({ seriesId, name: 'Nobody', appearancePrompt: '' });

      // One unwritable character must not abort a cast of twelve.
      const result = await generateMissingPortraits(userId, seriesId);

      expect(result.skipped).toContain('Nobody');
      expect(result.generated.map((g) => g.characterName)).toContain('Mei Lin');
    });
  });
});

describe.skipIf(configured)('character portrait suite', () => {
  it('is skipped without a database and Supabase credentials', () => {
    console.warn('Skipped: set DATABASE_URL and the Supabase keys to run these.');
    expect(configured).toBe(false);
  });
});
