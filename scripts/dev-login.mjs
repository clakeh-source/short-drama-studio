#!/usr/bin/env node
/**
 * Prints a working sign-in link for local development.
 *
 * Magic-link auth needs a mail round-trip, which is friction when you just want
 * a session to click around with. This mints one directly with the service-role
 * key, creating the user if it does not exist.
 *
 * DEVELOPMENT ONLY. It needs SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so
 * it must never be wired into anything a user can reach.
 *
 *   node scripts/dev-login.mjs [email]
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

if (!url || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const email = process.argv[2] ?? 'dev@example.com';
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

// Create the user if this is the first run. An "already registered" error is the
// expected path on every subsequent run.
const { error: createError } = await supabase.auth.admin.createUser({
  email,
  email_confirm: true,
});

if (createError && !/already/i.test(createError.message)) {
  console.error(`Could not create ${email}: ${createError.message}`);
  process.exit(1);
}

const { data, error } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email,
  options: { redirectTo: `${appUrl}/auth/callback` },
});

if (error || !data?.properties?.hashed_token) {
  console.error(`Could not generate a link: ${error?.message ?? 'no token returned'}`);
  process.exit(1);
}

/*
 * Print the app's own callback URL rather than Supabase's `/auth/v1/verify`
 * link. Two reasons: it keeps the whole flow on localhost (no cross-origin
 * hop), and `verify` hands back the session in the URL *fragment*, which the
 * server never sees — our callback route takes a `token_hash` and exchanges it
 * server-side with `verifyOtp`, so the cookies land properly.
 */
const callback = new URL('/auth/callback', appUrl);
callback.searchParams.set('token_hash', data.properties.hashed_token);
callback.searchParams.set('type', 'magiclink');

console.log(callback.toString());
