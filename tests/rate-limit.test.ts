import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';

/**
 * Per-user request ceilings on the routes that reach a provider.
 *
 * The spend cap bounds the bill; this bounds the rate. A loop that stops at the
 * cap has still made every request it took to get there, and a user who has
 * spent nothing this month is otherwise free to make all of them at once.
 *
 * The counter itself is one Postgres statement, exercised against a real
 * database in tests/rate-limit-db.test.ts territory — here the store is faked so
 * the *policy* (windows, the 429, Retry-After, fail-open) can be pinned without
 * one.
 */

const user = { id: 'user-1', email: 'dev@example.test' };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@/lib/auth');
  return { ...actual, requireApiUser: vi.fn(async () => user) };
});

vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Stands in for the `rate_limits` table: key → count. */
const counters = new Map<string, number>();
let storeFails = false;

const returning = vi.fn(async () => {
  if (storeFails) throw new Error('connection terminated unexpectedly');
  const key = pendingKey!;
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return [{ count: next }];
});

let pendingKey: string | null = null;

vi.mock('@/lib/db', () => ({
  db: () => ({
    insert: () => ({
      values: (row: { key: string }) => {
        pendingKey = row.key;
        return { onConflictDoUpdate: () => ({ returning }) };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  }),
}));

const { consumeRateLimit, RATE_LIMITS } = await import('@/lib/rate-limit');
const { route } = await import('@/lib/api/handler');

beforeEach(() => {
  counters.clear();
  storeFails = false;
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const rule = { limit: 3, windowSeconds: 60 };

describe('consumeRateLimit', () => {
  it('allows up to the limit and refuses past it', async () => {
    const verdicts = [];
    for (let i = 0; i < 5; i++) {
      verdicts.push(await consumeRateLimit(user.id, 'test.op', rule));
    }

    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false, false]);
    expect(verdicts[0]!.remaining).toBe(2);
    expect(verdicts[2]!.remaining).toBe(0);
  });

  it('counts each operation separately', async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(user.id, 'script.generate', rule);

    // Exhausting one route must not lock a user out of a different one.
    await expect(consumeRateLimit(user.id, 'export.caption', rule)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('counts each user separately', async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(user.id, 'test.op', rule);

    await expect(consumeRateLimit('user-2', 'test.op', rule)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('starts fresh in the next window', async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(user.id, 'test.op', rule);
    expect((await consumeRateLimit(user.id, 'test.op', rule)).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-08-20T12:01:00Z'));

    expect((await consumeRateLimit(user.id, 'test.op', rule)).allowed).toBe(true);
  });

  it('reports the seconds left in the window', async () => {
    vi.setSystemTime(new Date('2026-08-20T12:00:45Z'));

    const verdict = await consumeRateLimit(user.id, 'test.op', rule);

    expect(verdict.retryAfterSeconds).toBe(15);
  });

  it('allows the request when its own store is unreachable', async () => {
    storeFails = true;

    // A limiter that 500s the app when its table is down has done more damage
    // than the traffic it exists to shape.
    await expect(consumeRateLimit(user.id, 'test.op', rule)).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe('a route that declares a limit', () => {
  it('answers 429 with Retry-After once the window is spent', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const guarded = route({ operation: 'test.limited', rateLimit: rule }, handler);
    const request = () => new Request('http://test.local/api/thing', { method: 'POST' });

    for (let i = 0; i < 3; i++) {
      expect((await guarded(request())).status).toBe(200);
    }

    const refused = await guarded(request());

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    await expect(refused.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } });
    expect(handler, 'the handler must not run for a refused request').toHaveBeenCalledTimes(3);
  });

  it('leaves an unlimited route alone', async () => {
    const guarded = route({ operation: 'test.unlimited' }, async () => ({ ok: true }));

    for (let i = 0; i < 10; i++) {
      expect((await guarded(new Request('http://test.local/api/thing'))).status).toBe(200);
    }
  });
});

describe('the shared rules', () => {
  it('are all positive windows with positive limits', () => {
    for (const [name, value] of Object.entries(RATE_LIMITS)) {
      expect(value.limit, name).toBeGreaterThan(0);
      expect(value.windowSeconds, name).toBeGreaterThan(0);
    }
  });
});
