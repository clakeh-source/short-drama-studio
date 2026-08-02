import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
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
  ReuseError,
  pinnedShotKeyframe,
  reuseAsCharacterReference,
  reuseAsShotKeyframe,
} from '@/lib/assets/reuse';
import { loadAssetLibrary, resolveLibraryAsset } from '@/lib/data/assets';
import { pruneShotVersions } from '@/lib/data/generation';
import { CANONICAL_REFERENCE_SET_SIZE, MAX_REFERENCE_IMAGES } from '@/lib/characters/references';
import { statObject, uploadBuffer } from '@/lib/storage';
import { purgeUserObjects } from './support/storage';

/**
 * Reusing an asset somewhere else.
 *
 * The load-bearing claim is that reuse **copies**. A reference that merely
 * pointed at the source would work perfectly in every test that did not
 * regenerate a shot four times, and would then break silently in production
 * when the pruner deleted the object out from under it. So the pruning
 * interaction is asserted directly rather than reasoned about.
 *
 * Requires DATABASE_URL and Supabase credentials — storage is real here,
 * because "the copy exists and outlives its source" is the whole point and
 * cannot be shown against a stub.
 */
const configured = Boolean(
  process.env.DATABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const userId = crypto.randomUUID();
let seriesId: string;
let otherSeriesId: string;
let episodeId: string;
let shotId: string;
let meiId: string;
let otherSeriesCharacterId: string;

/** A real 1x1 PNG, so copies can be stat'd and signed like any other object. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A ready image asset on a shot, as the keyframe step would leave one. */
async function giveKeyframeAsset(version = 1): Promise<{ libraryId: string; storagePath: string }> {
  const object = await uploadBuffer({
    bucket: 'references',
    path: `${userId}/${episodeId}/keyframes/${shotId}/v${version}-${crypto.randomUUID()}.png`,
    buffer: PNG,
    contentType: 'image/png',
  });

  const [row] = await db()
    .insert(assets)
    .values({
      shotId,
      episodeId,
      kind: 'image',
      provider: 'stub',
      version,
      status: 'ready',
      storagePath: object.storagePath,
      costCents: 5,
      meta: { role: 'keyframe', ai_generated: true, bytes: object.bytes },
    })
    .returning({ id: assets.id });

  return { libraryId: `shot:${row!.id}`, storagePath: object.storagePath };
}

describe.skipIf(!configured)('reusing assets, against the database and storage', () => {
  beforeEach(async () => {
    await db().delete(series).where(eq(series.userId, userId));
    await purgeUserObjects(userId);

    const [s] = await db()
      .insert(series)
      .values({ userId, title: 'Reuse: The Last Ferry', logline: '' })
      .returning({ id: series.id });
    seriesId = s!.id;

    const [other] = await db()
      .insert(series)
      .values({ userId, title: 'Reuse: A Different Show', logline: '' })
      .returning({ id: series.id });
    otherSeriesId = other!.id;

    const [mei] = await db()
      .insert(characters)
      .values({ seriesId, name: 'Mei Lin', appearancePrompt: 'a woman in her thirties' })
      .returning({ id: characters.id });
    meiId = mei!.id;

    const [stranger] = await db()
      .insert(characters)
      .values({
        seriesId: otherSeriesId,
        name: 'Mei Lin (other show)',
        appearancePrompt: 'the same woman, different show',
      })
      .returning({ id: characters.id });
    otherSeriesCharacterId = stranger!.id;

    const [ep] = await db()
      .insert(episodes)
      .values({ seriesId, number: 1, title: 'Manifest' })
      .returning({ id: episodes.id });
    episodeId = ep!.id;

    const [sc] = await db()
      .insert(scenes)
      .values({ episodeId, orderIndex: 0, location: 'Terminal', timeOfDay: 'night' })
      .returning({ id: scenes.id });

    const [shot] = await db()
      .insert(shots)
      .values({
        sceneId: sc!.id,
        orderIndex: 0,
        durationSeconds: 5,
        camera: 'medium',
        action: 'Mei waits.',
        videoPrompt: 'A medium shot of Mei Lin at the ticket window.',
        characterIds: [meiId],
      })
      .returning({ id: shots.id });
    shotId = shot!.id;
  });

  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, userId));
    await purgeUserObjects(userId);
    await closeDb();
  });

  describe('the library sees everything', () => {
    it('lists a shot asset with provenance a person can read', async () => {
      await giveKeyframeAsset();

      const library = await loadAssetLibrary(userId);
      const keyframe = library.items.find((item) => item.role === 'keyframe');

      expect(keyframe).toBeDefined();
      expect(keyframe!.label).toContain('E1');
      expect(keyframe!.label).toContain('keyframe');
      expect(keyframe!.seriesTitle).toBe('Reuse: The Last Ferry');
      // Signed, so the card can show it without another round trip per item.
      expect(keyframe!.url).toMatch(/^https:\/\//);
    });

    it('does not list an asset that never landed', async () => {
      await db().insert(assets).values({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        version: 1,
        status: 'failed',
        costCents: 0,
      });

      const library = await loadAssetLibrary(userId);
      // A failed asset has no object. Showing it would offer a reuse that
      // cannot work and a download that 404s.
      expect(library.items.filter((i) => i.kind === 'video')).toHaveLength(0);
    });
  });

  describe('reuse as a character reference', () => {
    it('copies the object rather than pointing at it', async () => {
      const source = await giveKeyframeAsset();

      const result = await reuseAsCharacterReference({
        userId,
        libraryAssetId: source.libraryId,
        characterId: meiId,
      });

      expect(result.storagePath).not.toBe(source.storagePath);
      // Both exist: the copy is a second object, not a renamed one.
      expect(await statObject(result.storagePath)).not.toBeNull();
      expect(await statObject(source.storagePath)).not.toBeNull();
    });

    it('survives the source being pruned', async () => {
      // The failure this whole design exists to prevent. A reference pointing
      // at the source would still resolve here and break days later, when a
      // fourth take pushed the first one past KEEP_SHOT_VERSIONS.
      const source = await giveKeyframeAsset(1);
      const reused = await reuseAsCharacterReference({
        userId,
        libraryAssetId: source.libraryId,
        characterId: meiId,
      });

      for (const version of [2, 3, 4]) await giveKeyframeAsset(version);
      await pruneShotVersions(shotId);

      expect(await statObject(source.storagePath)).toBeNull();
      expect(await statObject(reused.storagePath)).not.toBeNull();
    });

    it('crosses series, which is the point of a global library', async () => {
      const source = await giveKeyframeAsset();

      const result = await reuseAsCharacterReference({
        userId,
        libraryAssetId: source.libraryId,
        // A character in an entirely different series.
        characterId: otherSeriesCharacterId,
      });

      expect(result.summary).toContain('Mei Lin (other show)');
      const [row] = await db()
        .select()
        .from(characterReferenceImages)
        .where(eq(characterReferenceImages.characterId, otherSeriesCharacterId));
      expect(row!.storagePath).toBe(result.storagePath);
    });

    it('applies the canonical rule instead of restating it', async () => {
      // Three stills is a canonical set; below that there is none at all, and
      // the generation job falls back to text-to-video.
      for (let i = 0; i < CANONICAL_REFERENCE_SET_SIZE; i++) {
        const source = await giveKeyframeAsset(1);
        await reuseAsCharacterReference({
          userId,
          libraryAssetId: source.libraryId,
          characterId: meiId,
        });
      }

      const rows = await db()
        .select()
        .from(characterReferenceImages)
        .where(eq(characterReferenceImages.characterId, meiId));

      expect(rows).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
      expect(rows.every((row) => row.isCanonical)).toBe(true);
      expect(rows.map((r) => r.orderIndex).sort()).toEqual([0, 1, 2]);
    });

    it('refuses past the maximum rather than silently dropping one', async () => {
      for (let i = 0; i < MAX_REFERENCE_IMAGES; i++) {
        const source = await giveKeyframeAsset(1);
        await reuseAsCharacterReference({
          userId,
          libraryAssetId: source.libraryId,
          characterId: meiId,
        });
      }

      const extra = await giveKeyframeAsset(1);
      await expect(
        reuseAsCharacterReference({ userId, libraryAssetId: extra.libraryId, characterId: meiId }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses a clip, which conditions nothing', async () => {
      const object = await uploadBuffer({
        bucket: 'clips',
        path: `${userId}/${episodeId}/${shotId}/v1.mp4`,
        buffer: Buffer.from('not really a video'),
        contentType: 'video/mp4',
      });
      const [row] = await db()
        .insert(assets)
        .values({
          shotId,
          episodeId,
          kind: 'video',
          provider: 'stub',
          version: 1,
          status: 'ready',
          storagePath: object.storagePath,
          costCents: 45,
        })
        .returning({ id: assets.id });

      await expect(
        reuseAsCharacterReference({
          userId,
          libraryAssetId: `shot:${row!.id}`,
          characterId: meiId,
        }),
      ).rejects.toBeInstanceOf(ReuseError);
    });

    it('refuses an asset belonging to someone else', async () => {
      const source = await giveKeyframeAsset();
      const stranger = crypto.randomUUID();

      // RLS, exercised through the resolve step: a library id is an input from
      // a browser, not a capability.
      expect(await resolveLibraryAsset(stranger, source.libraryId)).toBeNull();
      await expect(
        reuseAsCharacterReference({
          userId: stranger,
          libraryAssetId: source.libraryId,
          characterId: meiId,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('pinning a start frame', () => {
    it('is what the generation job will find', async () => {
      const source = await giveKeyframeAsset();

      await reuseAsShotKeyframe({ userId, libraryAssetId: source.libraryId, shotId });

      const pinned = await pinnedShotKeyframe(shotId);
      expect(pinned).not.toBeNull();
      expect(await statObject(pinned!.storagePath)).not.toBeNull();
    });

    it('costs nothing, because the image was already paid for', async () => {
      const source = await giveKeyframeAsset();
      await reuseAsShotKeyframe({ userId, libraryAssetId: source.libraryId, shotId });

      const [row] = await db()
        .select({ costCents: assets.costCents })
        .from(assets)
        .where(and(eq(assets.shotId, shotId), sql`${assets.meta}->>'pinned' = 'true'`));

      // Charging again would double-count it against the spend cap and
      // overstate what the film cost.
      expect(row!.costCents).toBe(0);
    });

    it('replaces the previous pin rather than accumulating', async () => {
      const first = await giveKeyframeAsset();
      const second = await giveKeyframeAsset();

      const one = await reuseAsShotKeyframe({ userId, libraryAssetId: first.libraryId, shotId });
      const two = await reuseAsShotKeyframe({ userId, libraryAssetId: second.libraryId, shotId });

      const pins = await db()
        .select()
        .from(assets)
        .where(and(eq(assets.shotId, shotId), sql`${assets.meta}->>'pinned' = 'true'`));

      // "The start frame" is singular; two would leave the job choosing with no
      // rule for which.
      expect(pins).toHaveLength(1);
      expect(pins[0]!.storagePath).toBe(two.storagePath);
      // And the superseded copy is gone, not orphaned.
      expect(await statObject(one.storagePath)).toBeNull();
    });

    it('is not pruned away by later takes', async () => {
      const source = await giveKeyframeAsset(1);
      const pin = await reuseAsShotKeyframe({ userId, libraryAssetId: source.libraryId, shotId });

      for (const version of [2, 3, 4, 5]) await giveKeyframeAsset(version);
      await pruneShotVersions(shotId);

      // A pin is an input to future takes, not the output of an old one.
      // Pruning it by version count would send the shot back to drawing its own
      // keyframe, silently, having been told not to.
      expect(await pinnedShotKeyframe(shotId)).not.toBeNull();
      expect(await statObject(pin.storagePath)).not.toBeNull();
    });
  });
});
