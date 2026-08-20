import type { NextConfig } from 'next';

/**
 * The headers that are the same on every response.
 *
 * Content-Security-Policy is deliberately absent: it carries a per-request
 * nonce and is set in middleware. See lib/security-headers.ts.
 */
const securityHeaders = [
  // Belt to the CSP's `frame-ancestors 'none'` braces, for anything that
  // predates CSP framing.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Stops a stored .txt being sniffed into a script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Episode and series ids live in the path; do not hand them to third parties.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The app asks for none of these, so it can say so.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  /**
   * Two years, subdomains included. Only meaningful over HTTPS — browsers
   * ignore it on a plain-HTTP origin, so it is harmless in local development.
   */
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  typescript: {
    // Never silently ship type errors — Phase 0 AC #1.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  serverExternalPackages: ['postgres'],
  headers: async () => [{ source: '/:path*', headers: securityHeaders }],
};

export default nextConfig;
