import 'server-only';

import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/**
 * The signed-in user, or null. Never throws.
 *
 * Memoised for the lifetime of one request. `auth.getUser()` verifies the token
 * with the auth server, which measured at 100-215ms here, and a single render
 * called it twice — once in the app layout and once in the page — for the same
 * user, doubling the wait before any HTML could be sent. `cache` collapses those
 * to one call per request without weakening the check: it is still a real
 * verification, just not repeated against itself.
 *
 * Per-request, not global: React clears the cache between requests, so one
 * user's session can never be served to another.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** For server components in the (app) group: redirects instead of rendering. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}

/** Thrown by route handlers when there is no session; mapped to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message = 'Not signed in') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** For route handlers: throws rather than redirecting. */
export async function requireApiUser(): Promise<User> {
  const user = await getUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
