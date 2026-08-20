/**
 * The rules for character reference stills.
 *
 * Kept in one module because they are enforced in three places that must not
 * drift: when upload URLs are issued (against what the client *claims*), when an
 * upload is confirmed (against what the store says is actually there), and in
 * the UI, which uses the same constants to disable the file picker.
 *
 * Deliberately free of imports altogether — no `server-only`, no schema, no
 * network client — so the rules can be unit-tested on their own and a client
 * component can read the constants without dragging Drizzle into the browser
 * bundle.
 */

/** Hard ceiling on stills per character. */
export const MAX_REFERENCE_IMAGES = 5;

/**
 * How many of them Kling gets.
 *
 * Mirrored by the `character_reference_images_order_bounds` CHECK constraint in
 * lib/db/schema.ts, which is written as a literal because a migration cannot
 * import TypeScript. tests/character-references.test.ts pins the two together.
 */
export const CANONICAL_REFERENCE_SET_SIZE = 3;

/** Kling takes stills. JPEG and PNG are what it accepts and what browsers produce. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

/** What the client says it is about to upload. All of it is a claim. */
export interface DeclaredUpload {
  filename: string;
  contentType: string;
  bytes: number;
}

export type Validation = { ok: true } | { ok: false; message: string };

const ok: Validation = { ok: true };
const fail = (message: string): Validation => ({ ok: false, message });

export function isAcceptedImageType(contentType: string): contentType is AcceptedImageType {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function extensionFor(contentType: string): string {
  return contentType === 'image/png' ? 'png' : 'jpg';
}

function describeBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Checks one file's declared content type and size.
 *
 * Also used on the confirm side against the *measured* values, which is the only
 * reading of these rules that is actually binding — see `validateStoredObject`.
 */
export function validateImage(input: { contentType: string; bytes: number }): Validation {
  if (!isAcceptedImageType(input.contentType)) {
    return fail(
      `${input.contentType || 'That file'} is not a supported image type. ` +
        `Use JPEG or PNG.`,
    );
  }

  if (input.bytes <= 0) {
    return fail('That file is empty.');
  }

  if (input.bytes > MAX_REFERENCE_IMAGE_BYTES) {
    return fail(
      `That image is ${describeBytes(input.bytes)}. The limit is ` +
        `${describeBytes(MAX_REFERENCE_IMAGE_BYTES)} per reference image.`,
    );
  }

  return ok;
}

/**
 * Checks a whole batch against the per-character ceiling.
 *
 * `existingCount` is read inside the same request that issues the URLs, so two
 * batches racing each other could in principle both pass here — the confirm step
 * re-checks, and the CHECK constraint on `order_index` is the backstop that
 * makes the ceiling true of the data no matter what.
 */
export function validateUploadBatch(
  files: readonly DeclaredUpload[],
  existingCount: number,
): Validation {
  if (files.length === 0) {
    return fail('Attach at least one reference image.');
  }

  const total = existingCount + files.length;
  if (total > MAX_REFERENCE_IMAGES) {
    const room = MAX_REFERENCE_IMAGES - existingCount;
    return fail(
      room <= 0
        ? `This character already has the maximum of ${MAX_REFERENCE_IMAGES} reference images. ` +
            `Remove one before adding another.`
        : `That would be ${total} reference images. The limit is ${MAX_REFERENCE_IMAGES}, ` +
            `so there is room for ${room} more.`,
    );
  }

  for (const file of files) {
    const result = validateImage(file);
    if (!result.ok) return fail(`${file.filename}: ${result.message}`);
  }

  return ok;
}

/**
 * The binding check, run after the bytes have landed.
 *
 * The upload went straight from the browser to the object store, so nothing the
 * client said on the way in was ever verified. `stored` is what the store
 * reports the object actually is; a mismatch against the declaration means the
 * object is rejected and deleted rather than recorded.
 */
export function validateStoredObject(
  stored: { bytes: number; contentType: string } | null,
): Validation {
  if (!stored) {
    return fail('That upload did not complete — nothing was stored at that path.');
  }
  return validateImage(stored);
}

/* -------------------------------------------------------------------------- */
/* Canonical set                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which stills Kling gets, given how many the character has.
 *
 * The rule is the spec's: once a character has at least
 * CANONICAL_REFERENCE_SET_SIZE stills, the first that many become the canonical
 * set. Below that there is no canonical set at all — the generation job falls
 * back to text-to-video rather than conditioning on a partial, inconsistent
 * reference, which is worse than none.
 */
export function isCanonicalAt(index: number, total: number): boolean {
  return total >= CANONICAL_REFERENCE_SET_SIZE && index < CANONICAL_REFERENCE_SET_SIZE;
}

/**
 * Recomputes order and canonical flags for a character's stills.
 *
 * Takes the rows in their current order and returns what each row's
 * `orderIndex` and `isCanonical` should become. Removals leave gaps in
 * `order_index`, and a gap would eventually push a surviving row past the
 * CHECK's upper bound, so positions are always renumbered contiguously from
 * zero rather than patched.
 */
export function resequence<T extends { id: string; orderIndex: number }>(
  rows: readonly T[],
): Array<{ id: string; orderIndex: number; isCanonical: boolean }> {
  return rows
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((row, index, all) => ({
      id: row.id,
      orderIndex: index,
      isCanonical: isCanonicalAt(index, all.length),
    }));
}
