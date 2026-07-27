import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';

/**
 * `sseRoute` — and specifically what happens when the browser goes away.
 *
 * The bug this file exists for: `send` guarded `controller.enqueue` on a local
 * `closed` flag, which only knew about closes the route itself performed. A
 * client disconnect closes the controller underneath it, so `enqueue` threw
 * `Invalid state: Controller is already closed` — from inside `onDelta`, deep
 * in the generation call — and tore the handler down before it reached its
 * `persist…` step. Three minutes of paid model output was generated, thrown
 * away, and the episode still read "No script yet".
 *
 * That is silent and expensive, so it is pinned here.
 */

const user = { id: 'user-1', email: 'dev@example.test' };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@/lib/auth');
  return { ...actual, requireApiUser: vi.fn(async () => user) };
});

// Keep the suite's output clean; the route logs an error on the failure paths.
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { sseRoute } = await import('@/lib/api/sse');

/** A promise the test resolves by hand, to hold a handler mid-flight. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

function post(): Request {
  return new Request('http://test.local/api/thing', { method: 'POST' });
}

const noParams = { params: Promise.resolve({}) };

/** Reads the whole stream and returns the decoded SSE text. */
async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sseRoute — the happy path still works', () => {
  it('frames each event and runs the handler to completion', async () => {
    const persisted = vi.fn();

    const route = sseRoute({ operation: 'test.op' }, async ({ send }) => {
      send('status', { message: 'working' });
      send('delta', { type: 'text', text: 'hello' });
      persisted();
      send('done', { ok: true });
    });

    const body = await drain(await route(post(), noParams));

    expect(body).toContain('event: status');
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');
    expect(body).toContain('"text":"hello"');
    expect(persisted).toHaveBeenCalledOnce();
  });

  it('reports a handler failure as an error frame', async () => {
    const route = sseRoute({ operation: 'test.op' }, async () => {
      throw new Error('model exploded');
    });

    const body = await drain(await route(post(), noParams));

    expect(body).toContain('event: error');
    // The generic message, not the raw internal one.
    expect(body).toContain('Nothing was saved');
  });
});

describe('sseRoute — the client disconnects mid-generation', () => {
  /**
   * The regression. The reader is cancelled while the handler is still
   * streaming, exactly as a closed tab or a superseding request does it.
   */
  it('finishes the work and persists it after the reader goes away', async () => {
    const held = gate();
    const finished = gate();
    const persisted = vi.fn();
    let sendThrew: unknown = null;

    const route = sseRoute({ operation: 'test.op' }, async ({ send }) => {
      send('delta', { type: 'text', text: 'first' });

      // The client disconnects while we are here.
      await held.waited;

      try {
        // Every one of these lands on a controller the client already closed.
        send('delta', { type: 'text', text: 'second' });
        send('status', { message: 'saving' });
      } catch (error) {
        sendThrew = error;
      }

      // The whole point: this must still run.
      persisted();
      send('done', { ok: true });
      finished.open();
    });

    // The `finally` still calls `controller.close()` on a controller the client
    // already closed; unguarded, that surfaces here and nowhere else.
    let unhandled: unknown = null;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const response = await route(post(), noParams);
      const reader = response.body!.getReader();

      // Take the first frame, then hang up.
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('first');
      await reader.cancel();

      held.open();
      await finished.waited;
      // Let any rejection from the `finally` surface before asserting.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(sendThrew, 'send must swallow a closed controller, not throw').toBeNull();
    expect(persisted, 'the work must be saved even though nobody is listening').toHaveBeenCalledOnce();
    expect(unhandled, 'closing an already-closed controller must not reject').toBeNull();
  });

  it('a handler that fails after the disconnect does not throw either', async () => {
    // `send('error', …)` in the catch block writes to the same dead controller.
    const held = gate();
    const settled = gate();
    let escaped: unknown = null;

    const route = sseRoute({ operation: 'test.op' }, async ({ send }) => {
      send('delta', { type: 'text', text: 'first' });
      await held.waited;
      throw new Error('failed after the client left');
    });

    const response = await route(post(), noParams);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    process.once('unhandledRejection', (error) => {
      escaped = error;
      settled.open();
    });

    held.open();
    await Promise.race([settled.waited, new Promise((r) => setTimeout(r, 200))]);

    expect(escaped, 'the error path must not produce an unhandled rejection').toBeNull();
  });
});
