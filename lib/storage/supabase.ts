import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import type {
  Bucket,
  ListedObject,
  ObjectStat,
  StorageProvider,
  StoredObject,
  UploadInput,
  UploadTicket,
} from './types';

/**
 * Supabase Storage, which is S3-compatible underneath.
 *
 * Buckets are private; nothing a user generates is world-readable. Playback goes
 * through short-lived signed URLs. Uses the service-role client because Inngest
 * functions run with no user session — ownership is established by the path
 * layout (`{userId}/{episodeId}/…`) and by the fact that only server code can
 * mint a signed URL for it.
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly id = 'supabase';

  private bucketName(bucket: Bucket): string {
    const config = env();
    return {
      clips: config.SUPABASE_BUCKET_CLIPS,
      audio: config.SUPABASE_BUCKET_AUDIO,
      renders: config.SUPABASE_BUCKET_RENDERS,
      references: config.SUPABASE_BUCKET_REFERENCES,
    }[bucket];
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    const supabase = createAdminClient();
    const name = this.bucketName(input.bucket);

    const { error } = await supabase.storage.from(name).upload(input.path, input.buffer, {
      contentType: input.contentType,
      // Regenerating a shot overwrites its clip rather than orphaning the old one.
      upsert: true,
    });

    if (error) {
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    log.info('stored object', {
      operation: 'storage.upload',
      bucket: name,
      path: input.path,
      bytes: input.buffer.byteLength,
    });

    return {
      storagePath: `${name}/${input.path}`,
      bucket: input.bucket,
      path: input.path,
      bytes: input.buffer.byteLength,
      contentType: input.contentType,
    };
  }

  async createUploadUrl(input: { bucket: Bucket; path: string }): Promise<UploadTicket> {
    const supabase = createAdminClient();
    const name = this.bucketName(input.bucket);

    // `upsert: true` so re-uploading into the same slot after a failed attempt
    // works. The slot is server-chosen and scoped to one character, so this
    // cannot be used to overwrite anything the caller does not already own.
    const { data, error } = await supabase.storage
      .from(name)
      .createSignedUploadUrl(input.path, { upsert: true });

    if (error || !data) {
      throw new Error(`Could not create an upload URL: ${error?.message ?? 'no data returned'}`);
    }

    return {
      uploadUrl: data.signedUrl,
      token: data.token,
      storagePath: `${name}/${input.path}`,
    };
  }

  async stat(storagePath: string): Promise<ObjectStat | null> {
    const split = splitStoragePath(storagePath);
    if (!split) return null;

    const supabase = createAdminClient();
    const { data, error } = await supabase.storage.from(split.bucket).info(split.path);

    // A missing object is a normal answer here — the confirm step calls this to
    // find out whether an upload actually happened.
    if (error || !data) return null;

    return {
      bytes: data.size ?? 0,
      contentType: data.contentType ?? 'application/octet-stream',
    };
  }

  async list(bucket: Bucket, prefix: string): Promise<ListedObject[]> {
    const supabase = createAdminClient();
    const name = this.bucketName(bucket);

    const { data, error } = await supabase.storage.from(name).list(prefix, { limit: 1000 });

    if (error) {
      throw new Error(`Could not list ${name}/${prefix}: ${error.message}`);
    }

    return (data ?? [])
      // `list` returns folders as entries with no metadata. They are not objects.
      .filter((entry) => entry.id !== null)
      .map((entry) => {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        return {
          storagePath: `${name}/${path}`,
          path,
          bytes: Number(entry.metadata?.size ?? 0),
          contentType: String(entry.metadata?.mimetype ?? 'application/octet-stream'),
        };
      });
  }

  async delete(storagePaths: readonly string[]): Promise<void> {
    const byBucket = groupByBucket(storagePaths);
    if (byBucket.size === 0) return;

    const supabase = createAdminClient();

    await Promise.all(
      [...byBucket].map(async ([bucket, paths]) => {
        const { error } = await supabase.storage.from(bucket).remove([...paths]);

        // Supabase reports a missing object as success, so anything that lands
        // here is a real failure — a revoked key, a bucket that does not exist.
        // Surfaced as a throw because the caller (deleting a character, say)
        // must not report the objects gone when they are still there.
        if (error) {
          throw new Error(`Storage delete failed for ${bucket}: ${error.message}`);
        }

        log.info('deleted objects', {
          operation: 'storage.delete',
          bucket,
          count: paths.length,
        });
      }),
    );
  }

  async getSignedUrl(storagePath: string, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
    const split = splitStoragePath(storagePath);
    if (!split) return null;

    const supabase = createAdminClient();
    const { data, error } = await supabase.storage
      .from(split.bucket)
      .createSignedUrl(split.path, ttlSeconds);

    if (error) {
      log.warn('could not sign storage url', {
        operation: 'storage.sign',
        bucket: split.bucket,
        path: split.path,
        error: error.message,
      });
      return null;
    }

    return data?.signedUrl ?? null;
  }

  /**
   * `createSignedUrl` is one HTTP request to the Storage API per object. The
   * generation board has a clip and a voice track per shot, so a twenty-shot
   * episode made up to forty of them; `createSignedUrls` signs a whole bucket's
   * worth in one request, turning forty into two.
   *
   * Worth about 100ms per page, measured — not the several hundred it looks like
   * it should be. The old calls were already issued concurrently, so their cost
   * was roughly one round trip plus connection overhead rather than forty round
   * trips. What this removes is the overhead and the load on the Storage API,
   * which also matters because the generation board re-signs every asset on a
   * three-second poll while jobs are running.
   */
  async getSignedUrls(
    storagePaths: readonly string[],
    ttlSeconds = SIGNED_URL_TTL_SECONDS,
  ): Promise<Map<string, string>> {
    const byBucket = groupByBucket(storagePaths);

    const signed = new Map<string, string>();
    if (byBucket.size === 0) return signed;

    const supabase = createAdminClient();

    await Promise.all(
      [...byBucket].map(async ([bucket, paths]) => {
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrls([...paths], ttlSeconds);

        if (error) {
          log.warn('could not batch-sign storage urls', {
            operation: 'storage.sign',
            bucket,
            count: paths.length,
            error: error.message,
          });
          return;
        }

        for (const row of data ?? []) {
          // Each row carries its own error when that one object is missing.
          if (row.signedUrl && row.path) signed.set(`${bucket}/${row.path}`, row.signedUrl);
        }
      }),
    );

    return signed;
  }
}

export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Splits `bucket/path`. Returns null for a string with no bucket prefix. */
export function splitStoragePath(storagePath: string): { bucket: string; path: string } | null {
  const slash = storagePath.indexOf('/');
  if (slash === -1) return null;
  return { bucket: storagePath.slice(0, slash), path: storagePath.slice(slash + 1) };
}

/** Buckets the `bucket/path` keys so each bucket takes one API call. */
function groupByBucket(storagePaths: readonly string[]): Map<string, string[]> {
  const byBucket = new Map<string, string[]>();

  for (const storagePath of new Set(storagePaths)) {
    const split = splitStoragePath(storagePath);
    if (!split) continue;
    const paths = byBucket.get(split.bucket);
    if (paths) paths.push(split.path);
    else byBucket.set(split.bucket, [split.path]);
  }

  return byBucket;
}
