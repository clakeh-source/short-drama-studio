import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, makeNonce } from '@/lib/security-headers';

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ['/login', '/auth', '/api/inngest'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase session cookie on every request and gates the
 * protected route group. Runs on the edge, so it reads process.env directly
 * rather than the (server-only, Node-flavoured) env module.
 */
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  /**
   * The nonce has to reach two places: the response, as policy, and Next's
   * renderer, so it stamps the same value on the script tags it emits. Next
   * reads it from the request headers — hence setting the policy on the way in
   * as well as on the way out.
   */
  const nonce = makeNonce();
  const csp = contentSecurityPolicy(nonce, url);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const nextResponse = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('content-security-policy', csp);
    return response;
  };

  let response = nextResponse();

  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = nextResponse();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not put anything between createServerClient and getUser(): getUser()
  // revalidates the token, and skipping it makes sessions silently expire.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    // API callers get the error envelope, not a redirect to an HTML page —
    // a 307 to /login would surface in fetch() as an opaque HTML success.
    if (pathname.startsWith('/api/')) {
      return withCsp(
        NextResponse.json(
          { error: { code: 'unauthorized', message: 'Not signed in' } },
          { status: 401 },
        ),
        csp,
      );
    }

    const redirect = request.nextUrl.clone();
    redirect.pathname = '/login';
    redirect.searchParams.set('next', pathname);
    return withCsp(NextResponse.redirect(redirect), csp);
  }

  if (user && pathname === '/login') {
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/series';
    redirect.search = '';
    return withCsp(NextResponse.redirect(redirect), csp);
  }

  return response;
}

/** Every exit from the middleware carries the policy, redirects included. */
function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set('content-security-policy', csp);
  return response;
}
