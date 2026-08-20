/**
 * The response headers a browser needs in order to defend the app for us.
 *
 * Split in two on purpose. The fixed ones are declared in `next.config.ts`,
 * because they are the same on every response and belong where they can be read
 * without tracing a request. The Content-Security-Policy is built here and set
 * in middleware, because it carries a per-request nonce — the only way to allow
 * Next's own inline bootstrap scripts without also allowing every other inline
 * script, which is the whole point of having a script policy at all.
 *
 * Runs on the edge runtime, so: Web Crypto, no Node APIs.
 */

/** 128 bits, base64. Fresh per request — a reused nonce is no nonce. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * `supabaseUrl` is threaded in rather than hardcoded so `connect-src` names the
 * one origin this deployment actually talks to. The browser client calls
 * Supabase directly for auth, and storage serves the signed URLs that clips and
 * voice tracks play from, so both connect and media have to reach it.
 */
export function contentSecurityPolicy(nonce: string, supabaseUrl: string | undefined): string {
  const supabase = originOf(supabaseUrl);

  return [
    "default-src 'self'",
    /**
     * `strict-dynamic` is what makes the nonce sufficient: scripts Next loads
     * from the nonced bootstrap inherit its trust, so the chunk files do not
     * each need enumerating. Browsers that honour it ignore the host list;
     * `'self'` is there for those that do not.
     */
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    /**
     * Inline styles stay allowed. React sets `style` attributes, and Next
     * inlines critical CSS during hydration — a nonce cannot cover either,
     * and the alternative is a policy that visibly breaks the app.
     */
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:" + supabase,
    "media-src 'self' blob:" + supabase,
    "font-src 'self' data:",
    "connect-src 'self'" + supabase,
    "worker-src 'self' blob:",
    // Nothing here embeds anything, and nothing here should be embedded.
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // Stops an injected <base> re-pointing every relative URL on the page.
    "base-uri 'self'",
    // A form that posts somewhere else is a credential-harvesting form.
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** ` https://project.supabase.co`, or nothing when the URL is unusable. */
function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return ` ${new URL(url).origin}`;
  } catch {
    return '';
  }
}
