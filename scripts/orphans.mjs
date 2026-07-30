#!/usr/bin/env node
/**
 * Reports — and optionally deletes — storage objects no database row points at.
 *
 * The FK cascade cannot reach the buckets, so any path that deletes rows without
 * first deleting their objects leaks silently and invisibly: the UI only ever
 * reads rows, so an orphan is a bill nobody will ever look for. Two such paths
 * existed and are fixed (a character's stills being regenerated, and test
 * teardown that walked rows the test had already cascaded away); this is how
 * they were found, and how a third would be.
 *
 * Read-only by default.
 *
 *   pnpm orphans            # report
 *   pnpm orphans --delete   # remove them
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

/** Walks a bucket, since `list` is per-prefix and not recursive. */
async function walk(bucket, prefix = '', depth = 0) {
  if (depth > 5) return [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) return [];

  const out = [];
  for (const entry of data ?? []) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) out.push(...(await walk(bucket, path, depth + 1)));
    else out.push({ key: `${bucket}/${path}`, bytes: Number(entry.metadata?.size ?? 0) });
  }
  return out;
}

try {
  const referenced = new Set(
    [
      ...(await sql`select storage_path from assets where storage_path is not null`),
      ...(await sql`select storage_path from renders where storage_path is not null`),
      ...(await sql`select storage_path from character_reference_images`),
      ...(await sql`select music_storage_path storage_path from series where music_storage_path is not null`),
    ].map((r) => r.storage_path),
  );

  let totalOrphans = 0;
  let totalBytes = 0;

  for (const bucket of ['clips', 'audio', 'renders', 'references']) {
    const objects = await walk(bucket);
    const orphans = objects.filter((o) => !referenced.has(o.key));
    const bytes = orphans.reduce((n, o) => n + o.bytes, 0);
    totalOrphans += orphans.length;
    totalBytes += bytes;

    console.log(
      `${bucket.padEnd(11)} ${String(objects.length).padStart(4)} objects, ` +
        `${String(orphans.length).padStart(4)} orphaned (${(bytes / 1024 / 1024).toFixed(2)}MB)`,
    );
    if (process.argv.includes('--delete') && orphans.length > 0) {
      const keys = orphans.map((o) => o.key.slice(bucket.length + 1));
      const { error } = await supabase.storage.from(bucket).remove(keys);
      console.log(error ? `  ! ${error.message}` : `  deleted ${keys.length}`);
    }
  }

  console.log(`\ntotal orphaned: ${totalOrphans} objects, ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
  if (!process.argv.includes('--delete') && totalOrphans > 0) {
    console.log('re-run with --delete to remove them');
  }
} finally {
  await sql.end();
}
