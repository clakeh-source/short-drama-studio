import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteObjects,
  setStorageProvider,
  signedUrl,
  signedUrls,
  splitStoragePath,
  storage,
  uploadBuffer,
} from '@/lib/storage';
import type {
  Bucket,
  ListedObject,
  ObjectStat,
  StorageProvider,
  StoredObject,
  UploadInput,
  UploadTicket,
} from '@/lib/storage';

/**
 * Phase 1 — the storage boundary.
 *
 * The point of `StorageProvider` is that the app's storage vocabulary
 * (`uploadBuffer`, `signedUrl`, `deleteObjects`, …) is a thin shell over one
 * swappable adapter, so moving off Supabase Storage is a new file rather than a
 * sweep through every call site. That only holds if the shell really does
 * delegate and holds no logic of its own — which is what these assert, using a
 * recording provider in place of the real one.
 */

class RecordingProvider implements StorageProvider {
  readonly id = 'recording';
  readonly uploads: UploadInput[] = [];
  readonly deletes: string[][] = [];
  readonly signs: Array<{ paths: string[]; ttlSeconds: number | undefined }> = [];

  async upload(input: UploadInput): Promise<StoredObject> {
    this.uploads.push(input);
    return {
      storagePath: `${input.bucket}/${input.path}`,
      bucket: input.bucket,
      path: input.path,
      bytes: input.buffer.byteLength,
      contentType: input.contentType,
    };
  }

  async delete(storagePaths: readonly string[]): Promise<void> {
    this.deletes.push([...storagePaths]);
  }

  async createUploadUrl(input: { bucket: Bucket; path: string }): Promise<UploadTicket> {
    return {
      uploadUrl: `https://upload.test/${input.bucket}/${input.path}`,
      token: 'token',
      storagePath: `${input.bucket}/${input.path}`,
    };
  }

  async stat(): Promise<ObjectStat | null> {
    return { bytes: 1, contentType: 'image/png' };
  }

  async list(): Promise<ListedObject[]> {
    return [];
  }

  async getSignedUrl(storagePath: string, ttlSeconds?: number): Promise<string | null> {
    this.signs.push({ paths: [storagePath], ttlSeconds });
    return `https://signed.test/${storagePath}`;
  }

  async getSignedUrls(
    storagePaths: readonly string[],
    ttlSeconds?: number,
  ): Promise<Map<string, string>> {
    this.signs.push({ paths: [...storagePaths], ttlSeconds });
    return new Map(storagePaths.map((p) => [p, `https://signed.test/${p}`]));
  }
}

afterEach(() => {
  setStorageProvider(null);
});

describe('StorageProvider delegation', () => {
  it('routes uploadBuffer to the active provider', async () => {
    const provider = new RecordingProvider();
    setStorageProvider(provider);

    const stored = await uploadBuffer({
      bucket: 'references',
      path: 'user/char/0.png',
      buffer: Buffer.from('png bytes'),
      contentType: 'image/png',
    });

    expect(provider.uploads).toHaveLength(1);
    expect(provider.uploads[0]!.bucket).toBe('references');
    expect(stored.storagePath).toBe('references/user/char/0.png');
    expect(stored.bytes).toBe(9);
  });

  it('routes deleteObjects to the active provider as one batched call', async () => {
    const provider = new RecordingProvider();
    setStorageProvider(provider);

    await deleteObjects(['references/a.png', 'references/b.png', 'clips/c.mp4']);

    // One call with three keys, not three calls — deleting a character's whole
    // reference set must not be N round trips.
    expect(provider.deletes).toEqual([['references/a.png', 'references/b.png', 'clips/c.mp4']]);
  });

  it('passes an explicit TTL through to the provider, and omits it otherwise', async () => {
    const provider = new RecordingProvider();
    setStorageProvider(provider);

    await signedUrl('clips/one.mp4', 120);
    await signedUrls(['clips/one.mp4', 'clips/two.mp4']);

    expect(provider.signs[0]).toEqual({ paths: ['clips/one.mp4'], ttlSeconds: 120 });
    // The default is the shell's, and it is a real number rather than undefined
    // — an adapter must never have to invent its own expiry.
    expect(provider.signs[1]!.paths).toHaveLength(2);
    expect(provider.signs[1]!.ttlSeconds).toBeGreaterThan(0);
  });

  it('restores the real provider when the override is cleared', () => {
    setStorageProvider(new RecordingProvider());
    expect(storage().id).toBe('recording');

    setStorageProvider(null);
    expect(storage().id).toBe('supabase');
  });
});

describe('splitStoragePath', () => {
  it('splits on the first slash only, so nested paths survive', () => {
    expect(splitStoragePath('clips/user/episode/shot/v0.mp4')).toEqual({
      bucket: 'clips',
      path: 'user/episode/shot/v0.mp4',
    });
  });

  it('returns null for a key with no bucket prefix', () => {
    // A bare filename is a caller mistake, and signing it against an arbitrary
    // bucket would be worse than refusing.
    expect(splitStoragePath('v0.mp4')).toBeNull();
  });
});
