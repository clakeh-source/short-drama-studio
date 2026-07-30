import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { characterReferenceImages, characters } from '@/lib/db/schema';
import { signedUrls } from '@/lib/storage';
import { log } from '@/lib/log';

/**
 * The stills a generation job conditions on.
 *
 * This is the read that decides image-to-video versus text-to-video, and it runs
 * inside an Inngest function with no user session — hence the privileged handle
 * and the `shot.characterIds` the event already carried, rather than RLS.
 */

export interface ShotReferenceSet {
  /** Signed URLs, in the order the provider should prefer them. */
  urls: string[];
  /** What went into the set, for the log and the asset's meta. */
  characters: Array<{ id: string; name: string; stills: number }>;
}

/**
 * How long a reference URL has to stay valid.
 *
 * The provider fetches the image when it picks the job up, which can be minutes
 * after submission if the queue is busy. The default one-hour signature would
 * usually be fine and would occasionally not be, and the failure mode — a job
 * that renders the prompt with no reference and silently changes the character's
 * face — is one nobody would attribute to an expired URL.
 */
const REFERENCE_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Canonical stills for every character in a shot, in shot order.
 *
 * Characters contribute in the order the shot lists them, and their stills in
 * canonical order, so the first URL belongs to the first-billed character. That
 * ordering matters: adapters whose model conditions on a single image send the
 * first one.
 *
 * Characters below the canonical threshold contribute nothing — deliberately.
 * A partial reference set conditions the model on an inconsistent view of
 * someone, which produces a worse result than no reference at all, so the shot
 * falls back to text-to-video rather than half-conditioning.
 */
export async function loadShotReferenceSet(
  characterIds: readonly string[],
): Promise<ShotReferenceSet> {
  if (characterIds.length === 0) return { urls: [], characters: [] };

  const handle = db();

  const rows = await handle
    .select({
      characterId: characterReferenceImages.characterId,
      storagePath: characterReferenceImages.storagePath,
      orderIndex: characterReferenceImages.orderIndex,
      name: characters.name,
    })
    .from(characterReferenceImages)
    .innerJoin(characters, eq(characters.id, characterReferenceImages.characterId))
    .where(
      and(
        inArray(characterReferenceImages.characterId, [...characterIds]),
        eq(characterReferenceImages.isCanonical, true),
      ),
    )
    .orderBy(asc(characterReferenceImages.orderIndex));

  if (rows.length === 0) return { urls: [], characters: [] };

  // Shot order, not query order: `inArray` gives no ordering guarantee, and the
  // first character in the shot should be the first reference the provider sees.
  const ordered = characterIds.flatMap((id) =>
    rows.filter((row) => row.characterId === id).sort((a, b) => a.orderIndex - b.orderIndex),
  );

  const signed = await signedUrls(
    ordered.map((row) => row.storagePath),
    REFERENCE_URL_TTL_SECONDS,
  );

  const urls = ordered
    .map((row) => signed.get(row.storagePath))
    .filter((url): url is string => Boolean(url));

  if (urls.length < ordered.length) {
    // Worth saying out loud. A reference that failed to sign does not fail the
    // job, but it does quietly weaken the character consistency this whole
    // mechanism exists to provide.
    log.warn('some reference stills could not be signed', {
      operation: 'reference_set.sign',
      wanted: ordered.length,
      signed: urls.length,
    });
  }

  const byCharacter = new Map<string, { id: string; name: string; stills: number }>();
  for (const row of ordered) {
    const existing = byCharacter.get(row.characterId);
    if (existing) existing.stills += 1;
    else byCharacter.set(row.characterId, { id: row.characterId, name: row.name, stills: 1 });
  }

  return { urls, characters: [...byCharacter.values()] };
}
