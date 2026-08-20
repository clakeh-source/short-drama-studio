#!/usr/bin/env node
/**
 * Build-time guard: no provider secret may ever be exposed to the browser, and
 * none may be committed.
 *
 * Three checks:
 *  1. No NEXT_PUBLIC_ variable in .env.example / .env.local carries a name that
 *     looks like a secret (KEY, TOKEN, SECRET, PASSWORD), with an explicit
 *     allowlist for the Supabase anon key, which is publishable by design.
 *  2. No secret in .env.example carries an actual value. That file is a
 *     template and — unlike .env, .env.local and .env*.local — it is NOT in
 *     .gitignore, so anything written there is committed. It had accumulated
 *     live Anthropic, ElevenLabs, Replicate, Inngest and Supabase service-role
 *     credentials before anyone noticed, which is what this check exists to
 *     prevent recurring.
 *  3. No source file outside lib/providers reads a known secret env var, and no
 *     client component ('use client') reads a non-public env var at all.
 *
 * Runs as part of `pnpm build`. Exits non-zero on any finding.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Publishable despite matching SECRET_NAME. */
const PUBLIC_ALLOWLIST = new Set(['NEXT_PUBLIC_SUPABASE_ANON_KEY']);

const SECRET_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'REPLICATE_API_TOKEN',
  'ELEVENLABS_API_KEY',
  'SHOTSTACK_API_KEY',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
];

/** Files allowed to read secrets: the env module and the provider adapters. */
const SECRET_READERS = [
  'lib/env.ts',
  'lib/providers/',
  'lib/inngest/client.ts',
  'app/api/inngest/route.ts',
  'lib/supabase/server.ts',
  'scripts/',
  'tests/',
  // The end-to-end suite signs itself in with the service-role key, the same way
  // `scripts/dev-login.mjs` does. It runs in Node under Playwright and is never
  // bundled — nothing under here is reachable from a browser.
  'e2e/',
  'drizzle.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
];

/** Matches an actual read of process.env.FOO — not `env().FOO`, which is the
 *  validated server-only accessor and is the sanctioned way to get a secret. */
const readsProcessEnv = (source, name) =>
  new RegExp(String.raw`process\.env(\.${name}\b|\[\s*['"\`]${name}['"\`]\s*\])`).test(source);

const findings = [];

/* -- check 1: env files ---------------------------------------------------- */

for (const file of ['.env.example', '.env.local', '.env']) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;

  for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    const match = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (PUBLIC_ALLOWLIST.has(name)) continue;
    if (SECRET_NAME.test(name.replace(/^NEXT_PUBLIC_/, ''))) {
      findings.push(`${file}:${i + 1}  ${name} looks like a secret but is browser-exposed.`);
    }
  }
}

/* -- check 2: no populated secrets in the committed template ---------------- */

/**
 * `.env.example` is the only env file git tracks, so it is the only one where a
 * value is a leak. `.env.local` is expected to be full of real credentials and
 * is deliberately not examined here.
 *
 * The rule is emptiness, not placeholder-detection: "does this look like a real
 * key" is a guess, whereas "a secret must have no value in the template" is
 * something a build can actually enforce.
 */
const EXAMPLE = join(ROOT, '.env.example');

if (existsSync(EXAMPLE)) {
  for (const [i, line] of readFileSync(EXAMPLE, 'utf8').split('\n').entries()) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!match) continue;

    const [, name, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');
    if (value === '') continue;

    // Publishable by design — the same exception check 1 makes.
    if (PUBLIC_ALLOWLIST.has(name)) continue;

    const isSecret = SECRET_VARS.includes(name) || SECRET_NAME.test(name);
    if (!isSecret) continue;

    findings.push(
      `.env.example:${i + 1}  ${name} has a value. ` +
        `.env.example is committed — put real credentials in .env.local and leave this empty.`,
    );
  }
}

/* -- check 3: source files ------------------------------------------------- */

// `.claude` holds agent worktrees: entire checkouts of this repo nested inside
// it. Scanning them reports another branch's files as if they were ours.
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.claude',
  'drizzle',
  'playwright-report',
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) yield full;
  }
}

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (rel === 'scripts/check-secrets.mjs') continue;

  const source = readFileSync(file, 'utf8');
  const isClient = /^\s*['"]use client['"]/m.test(source);
  const allowed = SECRET_READERS.some((prefix) => rel.startsWith(prefix));

  for (const name of SECRET_VARS) {
    if (!readsProcessEnv(source, name)) continue;
    if (isClient) {
      findings.push(`${rel}  client component reads secret env var ${name}.`);
    } else if (!allowed) {
      findings.push(
        `${rel}  reads process.env.${name} outside the allowed modules ` +
          `(lib/env.ts, lib/providers/**). Use env() from lib/env.ts instead.`,
      );
    }
  }

  if (isClient && /process\.env\.(?!NEXT_PUBLIC_)[A-Z0-9_]+/.test(source)) {
    findings.push(`${rel}  client component reads a non-NEXT_PUBLIC_ env var.`);
  }
}

if (findings.length > 0) {
  console.error('\n✗ Secret exposure check failed:\n');
  for (const f of findings) console.error(`  ${f}`);
  console.error('');
  process.exit(1);
}

console.log('✓ Secret exposure check passed');
