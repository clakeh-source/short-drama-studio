import 'server-only';

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { badRequest, notFound } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { characterReferenceImages, characters } from '@/lib/db/schema';
import { CANONICAL_REFERENCE_SET_SIZE, MAX_REFERENCE_IMAGES } from '@/lib/characters/references';
import { getImageProvider } from '@/lib/providers';
import {
  deleteObjects,
  downloadToBuffer,
  referenceImagePath,
  signedUrl,
  uploadBuffer,
} from '@/lib/storage';
import { log } from '@/lib/log';

/**
 * Turning a character's written appearance into photographs of them.
 *
 * The missing link for a one-prompt film. Kling's image-to-video conditions on
 * stills, and until now those had to be uploaded by hand — so a fully automatic
 * run could only ever produce text-to-video, where a character's face drifts
 * between shots. This generates the canonical set instead.
 *
 * `appearance_prompt` is already exactly the right input: the bible writes it as
 * a purely physical description with no names, story, emotion or camera, meant
 * to be reused verbatim in every prompt the character appears in. That is what a
 * text-to-image model wants, so nothing has to be translated.
 */

/**
 * The framings the canonical set covers.
 *
 * Three images rather than one because a single still gives the video model one
 * angle to work from, and it invents the rest. Front, three-quarter and a
 * looser framing between them span enough that a shot from any side has
 * something to anchor to.
 *
 * They share a seed, which makes them related rather than identical — a
 * diffusion model given one seed and three framings produces three images of a
 * consistent *type*, not three photographs of one person. That is the honest
 * limit of doing this without an identity-preserving model, and it is why the
 * set is reviewed on the cast page before anything is generated from it.
 */
const FRAMINGS = [
  'head-and-shoulders portrait, facing camera directly, neutral expression',
  'three-quarter view portrait, turned slightly away from camera',
  'upper-body shot, standing, arms relaxed at sides',
] as const;

/**
 * How long the hero still stays fetchable while the rest are generated.
 *
 * The identity model pulls the reference itself, so this has to outlive the
 * queue wait for every remaining framing. Generous, because the failure is
 * silent: an expired URL means the model generates from the prompt alone and
 * the set drifts, with nothing to distinguish it from a set that worked.
 */
const HERO_URL_TTL_SECONDS = 2 * 60 * 60;

/**
 * Style shared by every still, so the set reads as one shoot.
 *
 * Deliberately plain: these are reference photographs, not frames of the film.
 * Dramatic lighting or a location baked into a reference teaches the video model
 * that the character always looks like that.
 */
const STYLE =
  'photorealistic reference photograph, plain neutral grey studio backdrop, ' +
  'even soft lighting, sharp focus, no text, no watermark, no border';

export interface GeneratedPortraits {
  characterId: string;
  characterName: string;
  generated: number;
  costCents: number;
  /** Ids of the new rows, all of them canonical. */
  imageIds: string[];
  /**
   * Whether the set is one person or three cousins.
   *
   * True when every still after the first was conditioned on the first one's
   * face. False when the provider cannot do that and the set falls back to a
   * shared seed — recorded rather than hidden, because the difference is
   * invisible in the data and very visible on screen.
   */
  identityLocked: boolean;
}

/**
 * Generates and stores a character's canonical reference set.
 *
 * Replaces whatever was there: a half-generated set mixed with hand-uploaded
 * stills of a different person is worse than either alone, and the caller asked
 * for *this* character's set. Manual uploads still work, and still win if you
 * add them afterwards.
 */
export async function generateCharacterPortraits(
  userId: string,
  characterId: string,
  options: { count?: number } = {},
): Promise<GeneratedPortraits> {
  const count = Math.min(options.count ?? CANONICAL_REFERENCE_SET_SIZE, MAX_REFERENCE_IMAGES);

  const character = await withUserDb(userId, async (tx) => {
    const [row] = await tx.select().from(characters).where(eq(characters.id, characterId));
    if (!row) throw notFound('Character not found');
    return row;
  });

  const appearance = character.appearancePrompt.trim();
  if (!appearance) {
    // Generating from the name alone would produce a stranger, and that stranger
    // would then be baked into every clip.
    throw badRequest(
      `${character.name} has no appearance prompt yet. Write one — it is the description ` +
        `the images are generated from.`,
    );
  }

  const provider = getImageProvider();

  // The weak form of identity, and the fallback when the provider has no better.
  const seed = Math.floor(Math.random() * 2_147_483_647);

  /**
   * The first still is generated from the prompt alone and every later one is
   * generated from *its face*.
   *
   * That ordering is the whole mechanism. Generating all three from the same
   * text gives three people who match a description; generating two of them
   * from the first one's photograph gives one person in three poses. It costs
   * an extra round trip — the hero has to be stored and signed before the rest
   * can reference it — and that is the price of the set being coherent.
   */
  const framings = FRAMINGS.slice(0, count);
  const stored: Array<{
    storagePath: string;
    bytes: number;
    contentType: string;
    orderIndex: number;
  }> = [];

  let costCents = 0;
  let heroUrl: string | null = null;
  let identityLocked = false;

  for (const [index, framing] of framings.entries()) {
    const conditioned = Boolean(heroUrl) && provider.supportsIdentity;

    const result = await provider.generate({
      prompt: `${appearance}. ${framing}. ${STYLE}`,
      count: 1,
      aspectRatio: '9:16',
      seed,
      ...(conditioned ? { identityImageUrl: heroUrl! } : {}),
    });

    costCents += result.costCents;
    if (conditioned) identityLocked = true;

    const image = result.images[0];
    if (!image) continue;

    // Pulled into memory rather than handed to storage as a URL: the provider's
    // CDN link expires, and a reference the video model cannot fetch later is a
    // character whose face silently changes.
    const downloaded = await downloadToBuffer(image.url);
    const contentType = image.contentType || downloaded.contentType;

    const object = await uploadBuffer({
      bucket: 'references',
      path: referenceImagePath({
        userId,
        characterId,
        objectId: randomUUID(),
        extension: contentType === 'image/png' ? 'png' : 'jpg',
      }),
      buffer: downloaded.buffer,
      contentType,
    });

    stored.push({ ...object, orderIndex: index });

    // Sign the hero once it exists, so the remaining framings can be built on
    // it. Signed rather than public because the bucket is private and these are
    // a user's characters, not stock art.
    if (index === 0 && provider.supportsIdentity) {
      heroUrl = await signedUrl(object.storagePath, HERO_URL_TTL_SECONDS);

      if (!heroUrl) {
        // Without a fetchable hero the rest cannot be conditioned on it. Worth
        // saying: the set will still be produced, just not identity-locked.
        log.warn('could not sign the hero still; falling back to a shared seed', {
          userId,
          characterId,
          operation: 'character.portraits.identity.unavailable',
        });
      }
    }
  }

  if (stored.length === 0) {
    throw badRequest('The image model returned nothing to use as a reference.');
  }

  /**
   * The set being replaced, read before anything is written.
   *
   * Deleting the rows alone leaves their objects in the bucket with nothing
   * pointing at them — three images orphaned on every regeneration, invisible
   * because the UI only ever reads rows. Same ordering as everywhere else that
   * owns both: storage first, then the rows.
   */
  const previous = await withUserDb(userId, (tx) =>
    tx
      .select({ storagePath: characterReferenceImages.storagePath })
      .from(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, characterId)),
  );

  if (previous.length > 0) {
    await deleteObjects(previous.map((row) => row.storagePath));
  }

  const imageIds = await withUserDb(userId, async (tx) => {
    // Replace, not append — see the note on this function.
    await tx
      .delete(characterReferenceImages)
      .where(eq(characterReferenceImages.characterId, characterId));

    const rows = await tx
      .insert(characterReferenceImages)
      .values(
        stored.map((object) => ({
          characterId,
          storagePath: object.storagePath,
          contentType: object.contentType,
          bytes: object.bytes,
          orderIndex: object.orderIndex,
          // Generated as a set, so the whole set is canonical the moment it
          // reaches the threshold — no separate flagging pass.
          isCanonical: stored.length >= CANONICAL_REFERENCE_SET_SIZE,
        })),
      )
      .returning({ id: characterReferenceImages.id });

    return rows.map((r) => r.id);
  });

  log.info('generated character portraits', {
    userId,
    characterId,
    operation: 'character.portraits.generate',
    provider: provider.id,
    generated: stored.length,
    identityLocked,
    costCents,
  });

  return {
    characterId,
    characterName: character.name,
    generated: stored.length,
    costCents,
    imageIds,
    identityLocked,
  };
}

/**
 * Generates portraits for every character in a series that has none.
 *
 * The autorun's cast step. Skips characters that already have a canonical set,
 * so re-running after a partial failure costs only what is missing, and a set
 * someone curated by hand is never overwritten by a retry.
 */
export async function generateMissingPortraits(
  userId: string,
  seriesId: string,
): Promise<{ generated: GeneratedPortraits[]; skipped: string[]; costCents: number }> {
  const cast = await withUserDb(userId, (tx) =>
    tx
      .select({
        id: characters.id,
        name: characters.name,
        appearancePrompt: characters.appearancePrompt,
        existing: characterReferenceImages.id,
      })
      .from(characters)
      .leftJoin(
        characterReferenceImages,
        eq(characterReferenceImages.characterId, characters.id),
      )
      .where(eq(characters.seriesId, seriesId))
      .orderBy(asc(characters.createdAt)),
  );

  const withStills = new Set(cast.filter((c) => c.existing).map((c) => c.id));
  const seen = new Set<string>();

  const generated: GeneratedPortraits[] = [];
  const skipped: string[] = [];
  let costCents = 0;

  for (const member of cast) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);

    if (withStills.has(member.id)) {
      skipped.push(member.name);
      continue;
    }
    if (!member.appearancePrompt.trim()) {
      skipped.push(member.name);
      continue;
    }

    const result = await generateCharacterPortraits(userId, member.id);
    generated.push(result);
    costCents += result.costCents;
  }

  return { generated, skipped, costCents };
}
