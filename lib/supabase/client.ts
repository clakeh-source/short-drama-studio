'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client. Reads the publishable anon key only — RLS is what
 * protects the data, and no secret ever reaches this bundle.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. See .env.example.',
    );
  }

  return createBrowserClient(url, anonKey);
}
