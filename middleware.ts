import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. Auth cookies must be
     * refreshed on real navigations, not on every .png request.
     */
    '/((?!_next/static|_next/image|favicon.ico|stub/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|mp3|wav)$).*)',
  ],
};
