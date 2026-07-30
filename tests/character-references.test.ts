import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  ACCEPTED_IMAGE_TYPES,
  CANONICAL_REFERENCE_SET_SIZE,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  extensionFor,
  isCanonicalAt,
  resequence,
  validateImage,
  validateStoredObject,
  validateUploadBatch,
} from '@/lib/characters/references';

/**
 * Phase 2 — the reference-still rules.
 *
 * These run in three places that must agree: the browser (to fail fast), the
 * upload-URL route (against declared values), and the confirm step (against what
 * the object store says is really there). Testing them here rather than through
 * each caller is what makes "the same rules" a fact rather than an intention.
 */

const png = { contentType: 'image/png', bytes: 500_000 };

describe('validateImage', () => {
  it('accepts JPEG and PNG', () => {
    for (const contentType of ACCEPTED_IMAGE_TYPES) {
      expect(validateImage({ contentType, bytes: 1000 })).toEqual({ ok: true });
    }
  });

  it('names the offending type when it refuses one', () => {
    const result = validateImage({ contentType: 'image/gif', bytes: 1000 });

    expect(result.ok).toBe(false);
    // The message ends up in a 400 the user reads, so it has to say what was
    // wrong and what is allowed — not just "invalid".
    expect(result.ok === false && result.message).toMatch(/image\/gif/);
    expect(result.ok === false && result.message).toMatch(/JPEG or PNG/);
  });

  it('refuses an image over the size cap, in the units the user sees', () => {
    const result = validateImage({
      contentType: 'image/png',
      bytes: MAX_REFERENCE_IMAGE_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/10\.0MB/);
  });

  it('accepts an image exactly at the cap', () => {
    expect(
      validateImage({ contentType: 'image/png', bytes: MAX_REFERENCE_IMAGE_BYTES }),
    ).toEqual({ ok: true });
  });

  it('refuses an empty file', () => {
    expect(validateImage({ contentType: 'image/png', bytes: 0 }).ok).toBe(false);
  });
});

describe('validateUploadBatch', () => {
  it('requires at least one file', () => {
    expect(validateUploadBatch([], 0).ok).toBe(false);
  });

  it('accepts a batch that exactly fills the allowance', () => {
    const files = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => ({
      filename: `${i}.png`,
      ...png,
    }));

    expect(validateUploadBatch(files, 0)).toEqual({ ok: true });
  });

  it('counts what the character already has', () => {
    const result = validateUploadBatch([{ filename: 'six.png', ...png }], MAX_REFERENCE_IMAGES);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/already has the maximum/);
  });

  it('says how much room is left when a batch overshoots', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({ filename: `${i}.png`, ...png }));

    const result = validateUploadBatch(files, 3);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/room for 2 more/);
  });

  it('attributes a per-file failure to the file it came from', () => {
    const result = validateUploadBatch(
      [
        { filename: 'good.png', ...png },
        { filename: 'clip.mov', contentType: 'video/quicktime', bytes: 1000 },
      ],
      0,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/^clip\.mov:/);
  });
});

describe('validateStoredObject', () => {
  it('refuses when nothing was stored at the path', () => {
    // The upload went straight to the object store, so "the client said it
    // uploaded" and "an object exists" are different claims.
    const result = validateStoredObject(null);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/did not complete/);
  });

  it('applies the same rules to a measured object as to a declared one', () => {
    expect(validateStoredObject({ contentType: 'image/png', bytes: 1000 })).toEqual({ ok: true });
    expect(validateStoredObject({ contentType: 'text/html', bytes: 1000 }).ok).toBe(false);
    expect(
      validateStoredObject({ contentType: 'image/png', bytes: MAX_REFERENCE_IMAGE_BYTES + 1 }).ok,
    ).toBe(false);
  });
});

describe('extensionFor', () => {
  it('maps the accepted types to their extensions', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
  });
});

describe('canonical set', () => {
  it('flags nothing below the threshold', () => {
    for (let total = 0; total < CANONICAL_REFERENCE_SET_SIZE; total++) {
      for (let i = 0; i < total; i++) {
        // A partial reference set is worse than none: it conditions the model on
        // an inconsistent view of the character. Phase 4 falls back to
        // text-to-video instead.
        expect(isCanonicalAt(i, total)).toBe(false);
      }
    }
  });

  it('flags exactly the first three once the threshold is reached', () => {
    expect([0, 1, 2, 3, 4].map((i) => isCanonicalAt(i, 5))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('resequence', () => {
  it('closes the gap left by a removal and re-flags the set', () => {
    // Positions 0, 2, 3 are what remains after deleting the second of four.
    const rows = [
      { id: 'a', orderIndex: 0 },
      { id: 'c', orderIndex: 2 },
      { id: 'd', orderIndex: 3 },
    ];

    expect(resequence(rows)).toEqual([
      { id: 'a', orderIndex: 0, isCanonical: true },
      { id: 'c', orderIndex: 1, isCanonical: true },
      { id: 'd', orderIndex: 2, isCanonical: true },
    ]);
  });

  it('drops the canonical set entirely when it falls below the threshold', () => {
    const rows = [
      { id: 'a', orderIndex: 0 },
      { id: 'b', orderIndex: 4 },
    ];

    expect(resequence(rows).map((r) => r.isCanonical)).toEqual([false, false]);
  });

  it('never produces an index the CHECK constraint would refuse', () => {
    const rows = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => ({
      id: String(i),
      orderIndex: i * 3,
    }));

    for (const row of resequence(rows)) {
      expect(row.orderIndex).toBeLessThanOrEqual(MAX_REFERENCE_IMAGES - 1);
      expect(row.orderIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('sorts by position rather than trusting input order', () => {
    const rows = [
      { id: 'later', orderIndex: 4 },
      { id: 'first', orderIndex: 1 },
    ];

    expect(resequence(rows).map((r) => r.id)).toEqual(['first', 'later']);
  });
});

describe('the storage bucket mirrors the route rules', () => {
  it('caps the references bucket at the same size the route does', async () => {
    // The browser PUTs straight at a signed URL, so the route's own cap is not
    // on the path the bytes take — the bucket's is. They have to agree.
    const script = await readFile('scripts/create-buckets.mjs', 'utf8');
    const megabytes = MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024;

    expect(script).toMatch(new RegExp(`limit: '${megabytes}MB'`));
    expect(script).toMatch(/'image\/jpeg', 'image\/png'/);
  });
});
