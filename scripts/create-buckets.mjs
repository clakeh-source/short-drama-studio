#!/usr/bin/env node
/**
 * Creates the three private Storage buckets the pipeline writes to.
 * Idempotent — safe to re-run. Requires SUPABASE_SERVICE_ROLE_KEY.
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const BUCKETS = [
  { name: process.env.SUPABASE_BUCKET_CLIPS ?? 'clips', mime: ['video/mp4', 'video/webm'] },
  {
    name: process.env.SUPABASE_BUCKET_AUDIO ?? 'audio',
    mime: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4'],
  },
  { name: process.env.SUPABASE_BUCKET_RENDERS ?? 'renders', mime: ['video/mp4'] },
];

/**
 * Per-bucket ceiling. Must not exceed the project's global upload limit, which
 * is 50MB on the Supabase free tier — asking for more is rejected outright with
 * "The object exceeded the maximum allowed size". Raise this (and the project
 * limit) on a paid plan if 60-second renders start bumping against it.
 */
const FILE_SIZE_LIMIT = process.env.SUPABASE_FILE_SIZE_LIMIT ?? '50MB';

for (const bucket of BUCKETS) {
  const { error } = await supabase.storage.createBucket(bucket.name, {
    public: false, // signed URLs only; nothing a user generates is world-readable
    allowedMimeTypes: bucket.mime,
    fileSizeLimit: FILE_SIZE_LIMIT,
  });

  if (error && !/already exists/i.test(error.message)) {
    console.error(`✗ ${bucket.name}: ${error.message}`);
    process.exit(1);
  }
  console.log(`✓ ${bucket.name}${error ? ' (already existed)' : ' created'}`);
}
