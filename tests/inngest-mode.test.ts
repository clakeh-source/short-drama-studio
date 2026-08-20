import { afterEach, describe, expect, it } from 'vitest';
import { inngestIsDev } from '@/lib/inngest/mode';
import { env, resetEnvCache } from '@/lib/env';

/**
 * The endpoint that runs the jobs is public, and the signature is the only
 * thing that says a request came from Inngest.
 *
 * The SDK infers its own mode and infers *open*: anything it does not recognise
 * as production it calls dev, and in dev mode it skips signature validation
 * without looking at the request. That is fine on Vercel and wrong on a
 * self-hosted process started without NODE_ENV=production. These pin the
 * inverted polarity — cloud unless positively known to be dev — and the env
 * guard that goes with it.
 */

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  resetEnvCache();
});

/** The minimum a running app needs, so only the Inngest rule is under test. */
function baseEnv(): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    DATABASE_URL: 'postgres://localhost/test',
  };
}

describe('inngestIsDev', () => {
  it('is dev under `next dev`', () => {
    process.env = { ...original, NODE_ENV: 'development', INNGEST_DEV: '' };
    expect(inngestIsDev()).toBe(true);
  });

  it('is dev when INNGEST_DEV opts in, whatever NODE_ENV says', () => {
    // Running the dev server some other way — a test harness, a script.
    process.env = { ...original, NODE_ENV: 'production', INNGEST_DEV: '1' };
    expect(inngestIsDev()).toBe(true);
  });

  it('is not dev in production', () => {
    process.env = { ...original, NODE_ENV: 'production', INNGEST_DEV: '' };
    expect(inngestIsDev()).toBe(false);
  });

  it('is not dev in an environment it does not recognise', () => {
    // The case the SDK gets wrong: a container with nothing set. Guessing dev
    // here is guessing "skip signature validation".
    const bare = { ...original } as Record<string, string | undefined>;
    delete bare.NODE_ENV;
    delete bare.INNGEST_DEV;
    process.env = bare as NodeJS.ProcessEnv;

    expect(inngestIsDev()).toBe(false);
  });
});

describe('env() — the signing key outside dev', () => {
  it('refuses to start without one', () => {
    process.env = { ...baseEnv(), NODE_ENV: 'production' };
    resetEnvCache();

    expect(() => env()).toThrow(/INNGEST_SIGNING_KEY/);
  });

  it('starts once one is set', () => {
    process.env = { ...baseEnv(), NODE_ENV: 'production', INNGEST_SIGNING_KEY: 'signkey-prod-x' };
    resetEnvCache();

    expect(env().INNGEST_SIGNING_KEY).toBe('signkey-prod-x');
  });

  it('leaves a dev machine alone', () => {
    // Local development must keep working with `pnpm inngest:dev` and no keys.
    process.env = { ...baseEnv(), NODE_ENV: 'development' };
    resetEnvCache();

    expect(() => env()).not.toThrow();
    expect(env().INNGEST_SIGNING_KEY).toBeUndefined();
  });
});
