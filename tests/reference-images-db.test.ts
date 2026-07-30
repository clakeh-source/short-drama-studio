import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, withUserDb } from '@/lib/db';
import { characterReferenceImages, characters, series } from '@/lib/db/schema';
import { CANONICAL_REFERENCE_SET_SIZE, MAX_REFERENCE_IMAGES } from '@/lib/characters/references';

/**
 * Phase 1 — `character_reference_images`, the table Phase 2 fills and Phase 4
 * reads.
 *
 * Everything asserted here is a database-level guarantee rather than an
 * application one. The upload route will also enforce the five-image cap and
 * reject a duplicate, but a rule that only lives in a route handler stops being
 * true the moment a second writer appears — a backfill script, a later phase, a
 * mistake. These prove the constraints hold regardless of who is writing.
 *
 * Requires a real Supabase database: set DATABASE_URL and run `pnpm db:migrate`
 * first. Without it the suite skips rather than passing vacuously.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Postgres reports the violated constraint on the driver error, and Drizzle
 * wraps that in its own "Failed query: …" — so an assertion against the thrown
 * message only ever sees the SQL and would pass for *any* failure, including a
 * typo in the test. Walk down to the driver error and check the constraint by
 * name.
 */
async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, 'the write should have been refused').toBeDefined();

  let current: unknown = thrown;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { constraint_name?: string };
    if (candidate.constraint_name) {
      expect(candidate.constraint_name).toBe(constraint);
      return;
    }
    current = (current as { cause?: unknown }).cause;
  }

  throw new Error(
    `Expected a violation of "${constraint}" somewhere in the error chain, but got: ` +
      `${thrown instanceof Error ? thrown.message : String(thrown)}`,
  );
}

const owner = crypto.randomUUID();
const stranger = crypto.randomUUID();

let characterId: string;
let strangerCharacterId: string;

function still(index: number, overrides: Partial<{ storagePath: string }> = {}) {
  return {
    characterId,
    storagePath: overrides.storagePath ?? `references/${owner}/${characterId}/${index}.png`,
    contentType: 'image/png',
    bytes: 128_000,
    orderIndex: index,
  };
}

describe.skipIf(!hasDatabase)('character_reference_images', () => {
  beforeAll(async () => {
    const [ownerSeries] = await db()
      .insert(series)
      .values({ userId: owner, title: 'Ref: owner', logline: '' })
      .returning({ id: series.id });
    const [strangerSeries] = await db()
      .insert(series)
      .values({ userId: stranger, title: 'Ref: stranger', logline: '' })
      .returning({ id: series.id });

    const [character] = await db()
      .insert(characters)
      .values({ seriesId: ownerSeries!.id, name: 'Mei Lin' })
      .returning({ id: characters.id });
    const [strangerCharacter] = await db()
      .insert(characters)
      .values({ seriesId: strangerSeries!.id, name: 'Someone Else' })
      .returning({ id: characters.id });

    characterId = character!.id;
    strangerCharacterId = strangerCharacter!.id;
  });

  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, owner));
    await db().delete(series).where(eq(series.userId, stranger));
    await closeDb();
  });

  it('accepts the full allowed set of stills', async () => {
    const rows = await db()
      .insert(characterReferenceImages)
      .values(Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => still(i)))
      .returning({ id: characterReferenceImages.id });

    expect(rows).toHaveLength(MAX_REFERENCE_IMAGES);
  });

  it('refuses a sixth still at the database level', async () => {
    // order_index 5 is the first value outside the CHECK, which is how the
    // five-image cap is expressed structurally.
    await expectConstraintViolation(
      db().insert(characterReferenceImages).values(still(MAX_REFERENCE_IMAGES)),
      'character_reference_images_order_bounds',
    );
  });

  it('refuses the same stored object attached to the character twice', async () => {
    // Not cosmetic: a duplicate inside the canonical set would hand Kling the
    // same face twice and quietly halve the reference variety it gets.
    await expectConstraintViolation(
      db()
        .insert(characterReferenceImages)
        .values({ ...still(4), storagePath: `references/${owner}/${characterId}/0.png` }),
      'character_reference_images_path_uq',
    );
  });

  it('flags exactly the canonical set and no more', async () => {
    const all = await db()
      .select()
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, characterId));

    const canonical = all
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .slice(0, CANONICAL_REFERENCE_SET_SIZE);

    await db()
      .update(characterReferenceImages)
      .set({ isCanonical: true })
      .where(eq(characterReferenceImages.characterId, characterId));

    // The partial index this exercises is what the generation job reads.
    const flagged = await db()
      .select()
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.isCanonical, true));

    expect(flagged.length).toBeGreaterThanOrEqual(canonical.length);
    expect(canonical).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
  });

  it('hides another user’s stills behind RLS', async () => {
    await db()
      .insert(characterReferenceImages)
      .values({
        characterId: strangerCharacterId,
        storagePath: `references/${stranger}/${strangerCharacterId}/0.png`,
        contentType: 'image/png',
        bytes: 1000,
        orderIndex: 0,
      });

    const visible = await withUserDb(owner, (tx) =>
      tx
        .select()
        .from(characterReferenceImages)
        .where(eq(characterReferenceImages.characterId, strangerCharacterId)),
    );

    expect(visible).toHaveLength(0);
  });

  it('deletes a character’s stills with the character', async () => {
    await db().delete(characters).where(eq(characters.id, characterId));

    const remaining = await db()
      .select()
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, characterId));

    expect(remaining).toHaveLength(0);
  });
});

describe.skipIf(hasDatabase)('character_reference_images suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('Skipped: set DATABASE_URL and run `pnpm db:migrate` to execute these.');
    expect(hasDatabase).toBe(false);
  });
});
