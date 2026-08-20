import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';

/**
 * What a client is told when something goes wrong.
 *
 * Two habits this pins. Internal error text never crosses the wire — the music
 * upload route used to hand `error.message` straight to the caller, being the
 * one route that bypassed the shared mapper. And an auth failure is only
 * reported as an auth failure when that is what it was: the SSE wrapper used to
 * answer "Not signed in" with a 500 for anything that was not an
 * `UnauthorizedError`, so an unreachable auth server read as a stale session.
 */

const user = { id: 'user-1', email: 'dev@example.test' };
const requireApiUser = vi.fn(async () => user);

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@/lib/auth');
  return { ...actual, requireApiUser: () => requireApiUser() };
});

vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { route } = await import('@/lib/api/handler');
const { sseRoute } = await import('@/lib/api/sse');
const { UnauthorizedError } = await import('@/lib/auth');
const { MAX_PASTED_CHARS } = await import('@/lib/script-import/extract');

beforeEach(() => {
  vi.clearAllMocks();
  requireApiUser.mockResolvedValue(user);
});

const post = (body?: unknown) =>
  new Request('http://test.local/api/thing', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

describe('an unexpected failure inside a handler', () => {
  it('is a 500 that says nothing about itself', async () => {
    const guarded = route({ operation: 'test.op' }, async () => {
      throw new Error('password authentication failed for user "postgres"');
    });

    const response = await guarded(post());
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe('internal_error');
    expect(payload.error.message).not.toContain('postgres');
  });
});

describe('an auth check that fails for a reason other than "not signed in"', () => {
  it('is not reported to the client as a session problem', async () => {
    requireApiUser.mockRejectedValue(new Error('auth server unreachable'));

    const streamed = sseRoute({ operation: 'test.op' }, async () => {});
    const response = await streamed(post(), { params: Promise.resolve({}) });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe('internal_error');
    expect(payload.error.message).not.toMatch(/signed in/i);
    expect(payload.error.message).not.toContain('unreachable');
  });

  it('still reports a genuine missing session as a 401', async () => {
    requireApiUser.mockRejectedValue(new UnauthorizedError());

    const streamed = sseRoute({ operation: 'test.op' }, async () => {});
    const response = await streamed(post(), { params: Promise.resolve({}) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } });
  });
});

describe('pasted scripts are bounded like uploaded ones', () => {
  it('refuses more text than the upload path would have accepted', async () => {
    const { POST } = await import('@/app/api/script-import/parse/route');

    const response = await POST(post({ text: 'x'.repeat(MAX_PASTED_CHARS + 1) }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'bad_request' } });
  });

  it('accepts a normal screenplay', async () => {
    const { POST } = await import('@/app/api/script-import/parse/route');

    const response = await POST(
      post({ text: 'INT. KITCHEN - NIGHT\n\nShe sets the letter down.\n\nMAYA\nYou knew.\n' }),
    );

    expect(response.status).toBe(200);
  });
});
