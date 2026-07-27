import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { z } from 'zod';
import { log } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';

const paramsSchema = z.object({
  code: z.string().min(1).optional(),
  token_hash: z.string().min(1).optional(),
  type: z
    .enum(['email', 'magiclink', 'signup', 'recovery', 'invite', 'email_change'])
    .optional(),
  next: z.string().startsWith('/').optional(),
});

/**
 * Magic-link landing route. Supabase sends either a PKCE `code` or a
 * `token_hash` + `type` pair depending on project settings, so both are handled.
 * `next` is constrained to a same-site path so the link cannot be used as an
 * open redirect.
 */
export async function GET(request: NextRequest) {
  const parsed = paramsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));

  if (!parsed.success) {
    return redirectToError(request, 'invalid_link');
  }

  const { code, token_hash, type, next } = parsed.data;
  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      log.warn('magic link exchange failed', { operation: 'auth.callback', error: error.message });
      return redirectToError(request, 'link_expired');
    }
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash,
    });
    if (error) {
      log.warn('magic link verify failed', { operation: 'auth.callback', error: error.message });
      return redirectToError(request, 'link_expired');
    }
  } else {
    return redirectToError(request, 'invalid_link');
  }

  const destination = request.nextUrl.clone();
  destination.pathname = next ?? '/series';
  destination.search = '';
  return NextResponse.redirect(destination);
}

function redirectToError(request: NextRequest, reason: string) {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?error=${reason}`;
  return NextResponse.redirect(url);
}
