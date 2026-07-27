#!/usr/bin/env node
/**
 * Phase 5 AC #4 — Lighthouse performance >= 90 on the storyboard route.
 *
 * Runs against a **production build**, not the dev server. Measuring `next dev`
 * would be meaningless: it ships unminified bundles, an HMR client and no
 * compression, so it scores badly no matter how good the page is, and improving
 * that score would mean optimising for an artefact users never load.
 *
 * The storyboard is behind auth, so the run needs a session. Rather than drive a
 * sign-in inside Lighthouse, this mints a magic link with the service-role key
 * (as `scripts/dev-login.mjs` does), exchanges it for cookies with plain fetch,
 * and hands Lighthouse the resulting Cookie header.
 *
 *   pnpm build && pnpm start &        # or: PORT=3100 pnpm start
 *   node scripts/lighthouse.mjs <storyboard-url>
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';

config({ path: '.env.local', quiet: true });

const MIN_PERFORMANCE = 90;

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/lighthouse.mjs <url-of-a-storyboard-page>');
  process.exit(1);
}

const origin = new URL(target).origin;
const email = process.env.E2E_EMAIL ?? 'e2e@example.com';

/* -------------------------------------------------------------- sign in --- */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data, error } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email,
  options: { redirectTo: `${origin}/auth/callback` },
});

if (error || !data?.properties?.hashed_token) {
  console.error(`Could not mint a sign-in link: ${error?.message ?? 'no token'}`);
  process.exit(1);
}

const callback = new URL('/auth/callback', origin);
callback.searchParams.set('token_hash', data.properties.hashed_token);
callback.searchParams.set('type', 'magiclink');

// `manual` so the Set-Cookie headers on the redirect are readable.
const authResponse = await fetch(callback, { redirect: 'manual' });
const setCookies = authResponse.headers.getSetCookie?.() ?? [];

if (setCookies.length === 0) {
  console.error('The callback returned no cookies — is the server running at ' + origin + '?');
  process.exit(1);
}

const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');

/* ------------------------------------------------------------ lighthouse --- */

const chrome = await chromeLauncher.launch({
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
});

try {
  const result = await lighthouse(
    target,
    { port: chrome.port, output: 'json', logLevel: 'error' },
    /**
     * Lighthouse's own desktop preset, not a hand-rolled one.
     *
     * An earlier version set `formFactor: 'desktop'` and left throttling alone,
     * which silently kept the default **mobile** profile — simulated 4G at
     * 1.6 Mbps with a 4x CPU slowdown — and applied it to a desktop page. That is
     * not a harder version of the right test, it is the wrong test: this route
     * ships 230 KB of HTML, which takes over a second to transfer at 1.6 Mbps no
     * matter how fast the server is. The preset pairs the desktop form factor
     * with desktop throttling (40 ms RTT, 10 Mbps, no CPU slowdown).
     */
    {
      ...desktopConfig,
      settings: {
        ...desktopConfig.settings,
        // Performance only: the criterion is a performance score, and the other
        // categories triple the run time for numbers nothing asserts.
        onlyCategories: ['performance'],
        extraHeaders: { Cookie: cookieHeader },
      },
    },
  );

  const score = Math.round((result.lhr.categories.performance.score ?? 0) * 100);

  const metric = (id) => result.lhr.audits[id]?.displayValue ?? 'n/a';
  console.log(`\nLighthouse performance: ${score}  (threshold ${MIN_PERFORMANCE})`);
  console.log(`  First Contentful Paint   ${metric('first-contentful-paint')}`);
  console.log(`  Largest Contentful Paint ${metric('largest-contentful-paint')}`);
  console.log(`  Total Blocking Time      ${metric('total-blocking-time')}`);
  console.log(`  Cumulative Layout Shift  ${metric('cumulative-layout-shift')}`);
  console.log(`  Speed Index              ${metric('speed-index')}`);

  if (result.lhr.runWarnings?.length) {
    console.log('\nWarnings:');
    for (const warning of result.lhr.runWarnings) console.log(`  - ${warning}`);
  }

  if (score < MIN_PERFORMANCE) {
    console.error(`\nFAIL: ${score} is below the required ${MIN_PERFORMANCE}.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS`);
  }
} finally {
  await chrome.kill();
}
