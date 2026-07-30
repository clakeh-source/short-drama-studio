import { createAdminClient } from '@/lib/supabase/server';

/**
 * Removes every object a test user owns, across every bucket.
 *
 * Teardown that walks *rows* cannot be complete, because the thing being torn
 * down usually deletes the rows first: a `beforeEach` that drops the series
 * cascades away the characters, and with them any record of which objects
 * belonged to them. The objects survive, unreferenced and invisible, and the
 * bucket fills one test run at a time — 126 of them before anyone noticed.
 *
 * Every path in this codebase begins with the owning user's id, so the user is
 * the one handle that outlives the rows. That is what this deletes by.
 *
 * Reaches for the admin client rather than going through `StorageProvider`
 * deliberately: the interface hides folders from `list`, because nothing in the
 * app needs to walk a tree. Bending it for the convenience of teardown would be
 * the tail wagging the dog.
 *
 * Safe to call for a user that never wrote anything.
 */
const BUCKETS = ['clips', 'audio', 'renders', 'references'] as const;

export async function purgeUserObjects(userId: string): Promise<number> {
  const supabase = createAdminClient();
  let removed = 0;

  for (const bucket of BUCKETS) {
    const name = bucketName(bucket);
    const keys = await collect(supabase, name, userId);
    if (keys.length === 0) continue;

    const { error } = await supabase.storage.from(name).remove(keys);
    if (!error) removed += keys.length;
  }

  return removed;
}

function bucketName(bucket: (typeof BUCKETS)[number]): string {
  return (
    {
      clips: process.env.SUPABASE_BUCKET_CLIPS,
      audio: process.env.SUPABASE_BUCKET_AUDIO,
      renders: process.env.SUPABASE_BUCKET_RENDERS,
      references: process.env.SUPABASE_BUCKET_REFERENCES,
    }[bucket] ?? bucket
  );
}

/**
 * Every object under a prefix, recursively.
 *
 * `list` returns one level: files carry an `id`, folders do not. Depth is
 * bounded because the deepest path in the app is five segments, and an
 * unbounded walk against a misbehaving store would hang a suite rather than
 * fail it.
 */
async function collect(
  supabase: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 6) return [];

  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];

  const keys: string[] = [];

  for (const entry of data) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) keys.push(...(await collect(supabase, bucket, path, depth + 1)));
    else keys.push(path);
  }

  return keys;
}
