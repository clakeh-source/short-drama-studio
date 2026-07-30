import 'server-only';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SupabaseStorageProvider, SIGNED_URL_TTL_SECONDS } from './supabase';
import type {
  Bucket,
  ListedObject,
  ObjectStat,
  StorageProvider,
  StoredObject,
  UploadTicket,
} from './types';

export type {
  Bucket,
  ListedObject,
  ObjectStat,
  StorageProvider,
  StoredObject,
  UploadInput,
  UploadTicket,
} from './types';
export { SIGNED_URL_TTL_SECONDS, splitStoragePath } from './supabase';

/**
 * Object storage for the pipeline.
 *
 * The free functions below are the app's vocabulary and are what call sites use;
 * each one delegates to the active `StorageProvider`. Swapping the store means
 * writing one adapter and changing `storage()` — no call site moves.
 */

let provider: StorageProvider | null = null;

/** The active storage provider. */
export function storage(): StorageProvider {
  provider ??= new SupabaseStorageProvider();
  return provider;
}

/** Test seam: swap the provider, or pass nothing to restore the real one. */
export function setStorageProvider(next: StorageProvider | null): void {
  provider = next;
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
 *
 * Not on `StorageProvider`: it reads from *somewhere else* and never touches our
 * buckets, so it is the same code whatever the store underneath is.
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

export function uploadBuffer(input: {
  bucket: Bucket;
  path: string;
  buffer: Buffer;
  contentType: string;
}): Promise<StoredObject> {
  return storage().upload(input);
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

/** A short-lived playback URL for a stored object. */
export function signedUrl(
  storagePath: string,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
  return storage().getSignedUrl(storagePath, ttlSeconds);
}

/** Signs many paths at once, keyed by the `bucket/path` string that went in. */
export function signedUrls(
  storagePaths: readonly string[],
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  return storage().getSignedUrls(storagePaths, ttlSeconds);
}

/** Removes stored objects by `bucket/path`. Missing objects are not an error. */
export function deleteObjects(storagePaths: readonly string[]): Promise<void> {
  return storage().delete(storagePaths);
}

/** Mints a one-time URL for the browser to upload a single object to. */
export function createUploadUrl(input: { bucket: Bucket; path: string }): Promise<UploadTicket> {
  return storage().createUploadUrl(input);
}

/** What an object actually is. Null when nothing is stored at that key. */
export function statObject(storagePath: string): Promise<ObjectStat | null> {
  return storage().stat(storagePath);
}

/** Objects under a prefix. */
export function listObjects(bucket: Bucket, prefix: string): Promise<ListedObject[]> {
  return storage().list(bucket, prefix);
}

/* -------------------------------------------------------------------------- */
/* Path layout                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Paths are deterministic and carry both the version and the attempt.
 *
 * Both, because they mean different things. The attempt keeps a retry from
 * racing the upload it is replacing; the version is a directory, so "keep the
 * last three takes" is a prefix operation rather than a scan — see
 * `clipVersionPrefix`.
 */
export function clipPath(input: {
  userId: string;
  episodeId: string;
  shotId: string;
  version: number;
  attempt: number;
}): string {
  return `${clipVersionPrefix(input)}/a${input.attempt}.mp4`;
}

/** Everything belonging to one take of one shot. What pruning deletes. */
export function clipVersionPrefix(input: {
  userId: string;
  episodeId: string;
  shotId: string;
  version: number;
}): string {
  return `${input.userId}/${input.episodeId}/shots/${input.shotId}/v${input.version}`;
}

export function voicePath(input: {
  userId: string;
  episodeId: string;
  shotId: string;
  attempt: number;
}): string {
  return `${input.userId}/${input.episodeId}/voice/${input.shotId}/v${input.attempt}.wav`;
}

/**
 * A character reference still.
 *
 * The filename is server-generated rather than taken from the upload, for two
 * reasons: the client never gets to choose a path it can write to, and a slot
 * freed by a deletion is never reused, so a browser cache cannot serve the old
 * image at the new one's key.
 */
export function referenceImagePath(input: {
  userId: string;
  characterId: string;
  objectId: string;
  extension: string;
}): string {
  return `${input.userId}/${input.characterId}/${input.objectId}.${input.extension}`;
}

/** The prefix holding every still for one character. */
export function referenceImagePrefix(input: { userId: string; characterId: string }): string {
  return `${input.userId}/${input.characterId}`;
}

export function renderPath(input: {
  userId: string;
  episodeId: string;
  renderId: string;
}): string {
  return `${input.userId}/${input.episodeId}/renders/${input.renderId}.mp4`;
}
