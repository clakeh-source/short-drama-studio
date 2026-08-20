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
  // Character reference stills. JPEG and PNG only — the same allowlist the
  // upload route enforces, so a client that skips the app and PUTs straight at
  // a presigned URL still cannot store a GIF or an SVG here.
  {
    name: process.env.SUPABASE_BUCKET_REFERENCES ?? 'references',
    mime: ['image/jpeg', 'image/png'],
    // MAX_REFERENCE_IMAGE_BYTES in lib/characters/references.ts. Repeated here
    // because this bucket is written by the browser over a signed URL, so the
    // route's own limit is not on the path the bytes take.
    limit: '10MB',
  },
];

/**
 * Per-bucket ceiling. Must not exceed the project's global upload limit, which
 * is 50MB on the Supabase free tier — asking for more is rejected outright with
 * "The object exceeded the maximum allowed size". Raise this (and the project
 * limit) on a paid plan if 60-second renders start bumping against it.
 */
const FILE_SIZE_LIMIT = process.env.SUPABASE_FILE_SIZE_LIMIT ?? '50MB';

for (const bucket of BUCKETS) {
  const options = {
    public: false, // signed URLs only; nothing a user generates is world-readable
    allowedMimeTypes: bucket.mime,
    fileSizeLimit: bucket.limit ?? FILE_SIZE_LIMIT,
  };

  const { error } = await supabase.storage.createBucket(bucket.name, options);

  if (!error) {
    console.log(`✓ ${bucket.name} created`);
    continue;
  }

  if (!/already exists/i.test(error.message)) {
    console.error(`✗ ${bucket.name}: ${error.message}`);
    process.exit(1);
  }

  // An existing bucket is updated rather than skipped. Skipping made this script
  // idempotent in name only: a bucket created before a limit or MIME allowlist
  // changed kept the old settings forever, and the settings are load-bearing —
  // they are what constrains a browser uploading straight to a signed URL.
  const { error: updateError } = await supabase.storage.updateBucket(bucket.name, options);

  if (updateError) {
    console.error(`✗ ${bucket.name}: ${updateError.message}`);
    process.exit(1);
  }

  console.log(`✓ ${bucket.name} updated`);
}
