import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Supabase client bound to the request's cookies. Use in server components,
 * route handlers and server actions.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a server component, where cookies are read-only.
          // middleware.ts refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS — background jobs and storage writes only.
 * Never construct this in anything reachable from a client component.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    cookies: {
      getAll: () => [],
      setAll: () => {},
    },
  });
}
