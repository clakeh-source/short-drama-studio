import 'server-only';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAdminClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { log } from '@/lib/log';

/**
 * Supabase Storage access for background jobs.
 *
 * Buckets are private; nothing a user generates is world-readable. Playback goes
 * through short-lived signed URLs. Uses the service-role client because Inngest
 * functions run with no user session — ownership is established by the path
 * layout (`{userId}/{episodeId}/…`) and by the fact that only server code can
 * mint a signed URL for it.
 */

export type Bucket = 'clips' | 'audio' | 'renders';

function bucketName(bucket: Bucket): string {
  const config = env();
  return {
    clips: config.SUPABASE_BUCKET_CLIPS,
    audio: config.SUPABASE_BUCKET_AUDIO,
    renders: config.SUPABASE_BUCKET_RENDERS,
  }[bucket];
}

export interface StoredObject {
  /** `bucket/path`, as written to `assets.storage_path`. */
  storagePath: string;
  bucket: Bucket;
  path: string;
  bytes: number;
  contentType: string;
}

/**
 * Fetches a provider's output into memory, from the network or from disk.
 *
 * `file://` is handled explicitly because Node's `fetch` refuses it outright
 * ("not implemented... yet..."), and the local ffmpeg render adapter legitimately
 * produces a local file. Without this the whole `RENDER_PROVIDER=ffmpeg` path
 * could finish an encode and then fail to store it — which is exactly what
 * happened the first time a local render got far enough to try, the missing-libass
 * check having masked it until then.
 */
export async function downloadToBuffer(
  url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (url.startsWith('file://')) {
    const buffer = await readFile(fileURLToPath(url));
    if (buffer.byteLength === 0) {
      throw new Error('The rendered file is empty.');
    }
    // Extension-based, because a local file carries no content type. The render
    // adapter only ever writes MP4s; anything else is a caller mistake worth seeing.
    const contentType = url.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
    return { buffer, contentType };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the generated file (${response.status} from provider).`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength === 0) {
    throw new Error('The provider returned an empty file.');
  }

  return { buffer, contentType };
}

export async function uploadBuffer(input: {
  bucket: Bucket;
  path: string;
  buffer: Buffer;
  contentType: string;
}): Promise<StoredObject> {
  const supabase = createAdminClient();
  const name = bucketName(input.bucket);

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

/** Download from the provider and store in one step. */
export async function ingestFromUrl(input: {
  url: string;
  bucket: Bucket;
  path: string;
}): Promise<StoredObject> {
  const { buffer, contentType } = await downloadToBuffer(input.url);
  return uploadBuffer({ ...input, buffer, contentType });
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** A short-lived playback URL for a stored object. */
export async function signedUrl(
  storagePath: string,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
  const slash = storagePath.indexOf('/');
  if (slash === -1) return null;

  const bucket = storagePath.slice(0, slash);
  const path = storagePath.slice(slash + 1);

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds);

  if (error) {
    log.warn('could not sign storage url', {
      operation: 'storage.sign',
      bucket,
      path,
      error: error.message,
    });
    return null;
  }

  return data?.signedUrl ?? null;
}

/**
 * Signs many paths at once, keyed by the `bucket/path` string that went in.
 *
 * `createSignedUrl` is one HTTP request to the Storage API per object. The
 * generation board has a clip and a voice track per shot, so a twenty-shot
 * episode made up to forty of them; `createSignedUrls` signs a whole bucket's
 * worth in one request, turning forty into two.
 *
 * Worth about 100ms per page, measured — not the several hundred it looks like it
 * should be. The old calls were already issued concurrently, so their cost was
 * roughly one round trip plus connection overhead rather than forty round trips.
 * What this removes is the overhead and the load on the Storage API, which also
 * matters because the generation board re-signs every asset on a three-second
 * poll while jobs are running.
 *
 * Unsignable paths are simply absent from the result, matching `signedUrl`
 * returning null: a missing playback URL degrades a card, it does not fail a page.
 */
export async function signedUrls(
  storagePaths: readonly string[],
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const byBucket = new Map<string, string[]>();

  for (const storagePath of new Set(storagePaths)) {
    const slash = storagePath.indexOf('/');
    if (slash === -1) continue;
    const bucket = storagePath.slice(0, slash);
    const path = storagePath.slice(slash + 1);
    const paths = byBucket.get(bucket);
    if (paths) paths.push(path);
    else byBucket.set(bucket, [path]);
  }

  const signed = new Map<string, string>();
  if (byBucket.size === 0) return signed;

  const supabase = createAdminClient();

  await Promise.all(
    [...byBucket].map(async ([bucket, paths]) => {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, ttlSeconds);

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

/* -------------------------------------------------------------------------- */
/* Path layout                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Paths are deterministic and include the attempt, so a retry writes a new
 * object rather than racing the previous upload, and nothing is orphaned.
 */
export function clipPath(input: {
  userId: string;
  episodeId: string;
  shotId: string;
  attempt: number;
}): string {
  return `${input.userId}/${input.episodeId}/shots/${input.shotId}/v${input.attempt}.mp4`;
}

export function voicePath(input: {
  userId: string;
  episodeId: string;
  shotId: string;
  attempt: number;
}): string {
  return `${input.userId}/${input.episodeId}/voice/${input.shotId}/v${input.attempt}.wav`;
}

export function renderPath(input: {
  userId: string;
  episodeId: string;
  renderId: string;
}): string {
  return `${input.userId}/${input.episodeId}/renders/${input.renderId}.mp4`;
}
