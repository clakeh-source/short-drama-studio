import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { characterReferenceImages, characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import { buildShotKeyframe, keyframesEnabled } from '@/lib/characters/keyframe';
import { loadShotReferenceSet } from '@/lib/characters/reference-set';
import { CANONICAL_REFERENCE_SET_SIZE } from '@/lib/characters/references';
import { referenceImagePath, statObject, uploadBuffer } from '@/lib/storage';
import { purgeUserObjects } from './support/storage';

/**
 * Per-shot keyframes — the fix for multi-character shots.
 *
 * Kling conditions on one image per clip. Sending a character's studio portrait
 * meant a two-hander preserved only the first-billed face, and every clip opened
 * on a grey backdrop. A keyframe of the actual composition, conditioned on
 * everyone in the shot, replaces it.
 *
 * What matters is that *every* character reaches the request — an implementation
 * that quietly sent one would produce a plausible frame and the same bug.
 *
 * Requires DATABASE_URL and Supabase credentials.
 */
process.env.IMAGE_PROVIDER = 'stub';

const configured = Boolean(
  process.env.DATABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const userId = crypto.randomUUID();
let seriesId: string;
let episodeId: string;
let shotId: string;
let meiId: string;
let danielId: string;

/** A real 1x1 PNG, so the stills can actually be signed and fetched. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Gives a character a full canonical set, as the portrait stage would.
 *
 * The objects are uploaded for real rather than only inserted as rows:
 * `loadShotReferenceSet` signs the paths, and an object that is not there
 * cannot be signed — so row-only fixtures produce an empty reference set and
 * the keyframe silently declines, which is exactly what happened first time.
 */
async function giveStills(characterId: string): Promise<void> {
  const rows = [];

  for (let i = 0; i < CANONICAL_REFERENCE_SET_SIZE; i++) {
    const object = await uploadBuffer({
      bucket: 'references',
      path: referenceImagePath({
        userId,
        characterId,
        objectId: `still-${i}`,
        extension: 'png',
      }),
      buffer: PNG,
      contentType: 'image/png',
    });

    rows.push({
      characterId,
      storagePath: object.storagePath,
      contentType: 'image/png',
      bytes: object.bytes,
      orderIndex: i,
      isCanonical: true,
    });
  }

  await db().insert(characterReferenceImages).values(rows);
}

async function freshShot(): Promise<void> {
  await db().delete(series).where(eq(series.userId, userId));

  const [s] = await db()
    .insert(series)
    .values({ userId, title: 'Keyframes: two-hander', logline: '' })
    .returning({ id: series.id });
  seriesId = s!.id;

  const [mei] = await db()
    .insert(characters)
    .values({ seriesId, name: 'Mei Lin', appearancePrompt: 'a woman in her thirties' })
    .returning({ id: characters.id });
  const [daniel] = await db()
    .insert(characters)
    .values({ seriesId, name: 'Daniel Voss', appearancePrompt: 'a man in his forties' })
    .returning({ id: characters.id });

  meiId = mei!.id;
  danielId = daniel!.id;
  await giveStills(meiId);
  await giveStills(danielId);

  const [ep] = await db()
    .insert(episodes)
    .values({ seriesId, number: 1 })
    .returning({ id: episodes.id });
  episodeId = ep!.id;

  const [sc] = await db()
    .insert(scenes)
    .values({ episodeId, orderIndex: 0, location: 'Ferry deck', timeOfDay: 'night' })
    .returning({ id: scenes.id });

  // A two-hander: the shot both characters are in.
  const [shot] = await db()
    .insert(shots)
    .values({
      sceneId: sc!.id,
      orderIndex: 0,
      durationSeconds: 5,
      camera: 'two-shot',
      action: 'Mei steps out of the stairwell behind him.',
      videoPrompt: 'two-shot. Mei steps out of the stairwell behind Daniel. Ferry deck, night.',
      characterIds: [meiId, danielId],
    })
    .returning({ id: shots.id });
  shotId = shot!.id;
}

describe.skipIf(!configured)('shot keyframes', () => {
  beforeEach(freshShot);

  afterAll(async () => {
    await purgeUserObjects(userId);
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('is on by default', () => {
    expect(keyframesEnabled()).toBe(true);
  });

  it('conditions on every character in the shot, not just the first', async () => {
    const references = await loadShotReferenceSet([meiId, danielId]);

    // Both characters' canonical sets reach the request. Sending only Mei's is
    // the bug — Daniel would be drawn from the prompt and be a different
    // stranger in every shot.
    expect(references.characters.map((c) => c.name)).toEqual(['Mei Lin', 'Daniel Voss']);
    expect(references.urls).toHaveLength(CANONICAL_REFERENCE_SET_SIZE * 2);

    const keyframe = await buildShotKeyframe({
      userId,
      episodeId,
      shotId,
      version: 1,
      prompt: 'two-shot. Mei steps out of the stairwell behind Daniel. Ferry deck, night.',
      references,
    });

    expect(keyframe).not.toBeNull();
    expect(keyframe!.facesRequested).toBe(CANONICAL_REFERENCE_SET_SIZE * 2);
  });

  it('reports how many faces the model actually read, not how many were sent', async () => {
    const references = await loadShotReferenceSet([meiId, danielId]);
    const keyframe = await buildShotKeyframe({
      userId,
      episodeId,
      shotId,
      version: 1,
      prompt: 'two-shot on the ferry deck',
      references,
    });

    // The stub reads one, like PuLID. Claiming both were used would be the same
    // silent failure in a different place: the number has to be honest so the
    // asset row says whether the two-hander is genuinely locked.
    expect(keyframe!.facesUsed).toBe(1);
    expect(keyframe!.facesUsed).toBeLessThanOrEqual(keyframe!.facesRequested);
  });

  it('stores a real, fetchable frame', async () => {
    const references = await loadShotReferenceSet([meiId, danielId]);
    const keyframe = await buildShotKeyframe({
      userId,
      episodeId,
      shotId,
      version: 1,
      prompt: 'two-shot on the ferry deck',
      references,
    });

    // The video provider fetches this itself, so it has to exist as an object
    // and be signed — not merely referenced.
    const stored = await statObject(keyframe!.storagePath);
    expect(stored).not.toBeNull();
    expect(stored!.bytes).toBeGreaterThan(0);
    expect(keyframe!.url).toMatch(/^https?:\/\//);
    // Filed with the shot it belongs to, not with the character stills.
    expect(keyframe!.storagePath).toContain(`/keyframes/${shotId}/`);
  });

  it('is drawn from the shot’s prompt, so the frame is the scene not a portrait', async () => {
    const references = await loadShotReferenceSet([meiId, danielId]);

    const deck = await buildShotKeyframe({
      userId, episodeId, shotId, version: 1,
      prompt: 'two-shot on the ferry deck at night',
      references,
    });
    const terminal = await buildShotKeyframe({
      userId, episodeId, shotId, version: 2,
      prompt: 'wide shot of the harbour terminal, rain on the glass',
      references,
    });

    // Different composition, different frame — a portrait would be identical
    // regardless of what the shot is of, which is the thing being fixed.
    expect(deck!.storagePath).not.toBe(terminal!.storagePath);
  });

  it('declines rather than failing when the shot has no cast', async () => {
    // No faces to hold means a keyframe buys nothing over text-to-video, and
    // costing an image for it would be waste.
    const keyframe = await buildShotKeyframe({
      userId,
      episodeId,
      shotId,
      version: 1,
      prompt: 'insert. A boarding pass held at the rail.',
      references: { urls: [], characters: [] },
    });

    expect(keyframe).toBeNull();
  });

  it('declines when keyframes are switched off', async () => {
    const original = process.env.SHOT_KEYFRAMES;
    process.env.SHOT_KEYFRAMES = 'off';

    try {
      const references = await loadShotReferenceSet([meiId, danielId]);
      // Falls back to the character stills rather than failing the shot.
      expect(keyframesEnabled()).toBe(false);
      expect(
        await buildShotKeyframe({
          userId, episodeId, shotId, version: 1,
          prompt: 'two-shot', references,
        }),
      ).toBeNull();
    } finally {
      if (original === undefined) delete process.env.SHOT_KEYFRAMES;
      else process.env.SHOT_KEYFRAMES = original;
    }
  });
});

describe.skipIf(configured)('shot keyframe suite', () => {
  it('is skipped without a database and Supabase credentials', () => {
    console.warn('Skipped: set DATABASE_URL and the Supabase keys to run these.');
    expect(configured).toBe(false);
  });
});
