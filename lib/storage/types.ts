/**
 * The storage boundary.
 *
 * Object storage is reached only through `StorageProvider`. Nothing outside
 * /lib/storage constructs a Supabase Storage client or an S3 client, so moving
 * to raw S3 (or to R2, or to disk in a test) is one new file implementing this
 * interface plus one line in index.ts.
 *
 * Kept dependency-free like lib/providers/types.ts so tests can import it
 * without pulling in `server-only` or a network client.
 */

/**
 * Logical bucket. Named by role rather than by the configured bucket name so
 * call sites never hard-code a string from the environment.
 */
export type Bucket = 'clips' | 'audio' | 'renders' | 'references';

/** A stored object, as recorded on `assets.storage_path` and friends. */
export interface StoredObject {
  /** `bucket/path` — the resolved bucket name, not the logical one. */
  storagePath: string;
  bucket: Bucket;
  path: string;
  bytes: number;
  contentType: string;
}

export interface UploadInput {
  bucket: Bucket;
  path: string;
  buffer: Buffer;
  contentType: string;
}

/** A one-time URL the browser can PUT a single object to. */
export interface UploadTicket {
  /** Where the client sends the bytes. */
  uploadUrl: string;
  /** Some stores hand back a separate token; empty string when they do not. */
  token: string;
  /** The `bucket/path` the object will land at, for the confirm step. */
  storagePath: string;
}

/** What an object actually is, as opposed to what the client claimed. */
export interface ObjectStat {
  bytes: number;
  contentType: string;
}

/** One object in a bucket listing. */
export interface ListedObject extends ObjectStat {
  /** `bucket/path`, so it can be fed straight back to delete/getSignedUrl. */
  storagePath: string;
  path: string;
}

export interface StorageProvider {
  readonly id: string;

  /** Writes an object and returns its `bucket/path` key. Overwrites by design. */
  upload(input: UploadInput): Promise<StoredObject>;

  /**
   * Mints a URL the browser uploads to directly, so large files never transit
   * the Next.js server.
   *
   * The returned ticket is a capability: anyone holding it can write that one
   * path until it expires. It is therefore only ever issued for a path the
   * server chose, never one the client supplied.
   */
  createUploadUrl(input: { bucket: Bucket; path: string }): Promise<UploadTicket>;

  /**
   * Size and content type of a stored object, or null if it is not there.
   *
   * This is what makes direct-to-storage uploads safe to trust. The bytes never
   * passed through the server, so the only honest way to know what was actually
   * written is to ask the store after the fact — a declared content type on the
   * way in is a claim, not a fact.
   */
  stat(storagePath: string): Promise<ObjectStat | null>;

  /** Objects under a prefix. Non-recursive, like the underlying stores. */
  list(bucket: Bucket, prefix: string): Promise<ListedObject[]>;

  /**
   * Removes objects by `bucket/path` key.
   *
   * Takes a list because every real caller has one — deleting a character
   * removes its whole reference set, deleting an episode its whole clip set —
   * and one request per object is a poor way to spend a delete.
   *
   * Deleting something that is already gone is not an error: callers use this
   * to converge on "no longer stored", and a retry after a partial failure must
   * not fail on the objects the first attempt got to.
   */
  delete(storagePaths: readonly string[]): Promise<void>;

  /**
   * A short-lived read URL, or null if the object cannot be signed.
   *
   * Null rather than a throw: a missing playback URL degrades one card in the
   * UI, it does not fail the page that card is on.
   */
  getSignedUrl(storagePath: string, ttlSeconds?: number): Promise<string | null>;

  /**
   * `getSignedUrl` for many keys, batched per bucket. Unsignable keys are
   * absent from the result rather than mapped to null.
   */
  getSignedUrls(
    storagePaths: readonly string[],
    ttlSeconds?: number,
  ): Promise<Map<string, string>>;
}
