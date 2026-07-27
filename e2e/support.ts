import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import type { Page, TestInfo } from '@playwright/test';

loadEnv({ path: '.env.local', quiet: true });

/**
 * Shared machinery for the end-to-end journey.
 *
 * Signing in goes around the mail round-trip the way `scripts/dev-login.mjs`
 * does — minting a magic link with the service-role key and handing the app its
 * own `/auth/callback` URL, so the token is exchanged server-side and the cookies
 * land properly. Nothing here runs in the browser; the service key never leaves
 * the test process.
 */

export const E2E_EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'The e2e suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.',
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Signs the page in as a dedicated e2e account, creating it on first run. */
export async function signIn(page: Page, baseURL: string): Promise<void> {
  const supabase = admin();

  const { error: createError } = await supabase.auth.admin.createUser({
    email: E2E_EMAIL,
    email_confirm: true,
  });
  if (createError && !/already/i.test(createError.message)) {
    throw new Error(`Could not create the e2e user: ${createError.message}`);
  }

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: E2E_EMAIL,
    options: { redirectTo: `${baseURL}/auth/callback` },
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`Could not mint a sign-in link: ${error?.message ?? 'no token'}`);
  }

  const callback = new URL('/auth/callback', baseURL);
  callback.searchParams.set('token_hash', data.properties.hashed_token);
  callback.searchParams.set('type', 'magiclink');

  await page.goto(callback.toString());
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'));
}

/**
 * Phase 5 AC #5 — zero unhandled promise rejections across the run.
 *
 * `pageerror` covers uncaught exceptions *and* unhandled rejections in Chromium.
 * Console errors are collected separately: a failed request logged to the console
 * is not a rejection, and conflating the two would make the assertion either
 * too noisy or too weak.
 */
export interface PageProblems {
  pageErrors: string[];
  consoleErrors: string[];
}

export function watchForProblems(page: Page): PageProblems {
  const problems: PageProblems = { pageErrors: [], consoleErrors: [] };

  page.on('pageerror', (error) => {
    problems.pageErrors.push(`${error.name}: ${error.message}`);
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Chromium logs a console error for every non-2xx response. Those are the
    // app's own handled paths (a 401 probe, an aborted poll) and are asserted
    // elsewhere; they are not unhandled rejections.
    if (/Failed to load resource/i.test(text)) return;
    problems.consoleErrors.push(text);
  });

  return problems;
}

/** Removes everything the journey created, so re-runs start clean. */
export async function deleteSeriesNamed(premiseFragment: string): Promise<void> {
  const supabase = admin();
  const { data } = await supabase.auth.admin.listUsers();
  const user = data?.users.find((u) => u.email === E2E_EMAIL);
  if (!user) return;

  // Cascades to episodes, scenes, shots, assets and renders.
  await supabase
    .from('series')
    .delete()
    .eq('user_id', user.id)
    .ilike('logline', `%${premiseFragment}%`);
}

/** Attaches a screenshot so a CI failure is diagnosable without a rerun. */
export async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
}
