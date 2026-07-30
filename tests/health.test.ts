import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDatabase, checkQueue, rollUp } from '@/lib/health';
import { closeDb } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';

/**
 * Phase 1 AC #4 — /api/health reports the status of the database and the job
 * queue.
 *
 * The checks are tested rather than the route because the route is four lines
 * over `healthReport()`; what can actually be wrong is a probe that reports `ok`
 * for a dependency it never reached.
 */

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCache();
});

describe('rollUp', () => {
  it('takes the worst status, so one dead dependency fails the whole check', () => {
    expect(rollUp([{ status: 'ok' }, { status: 'ok' }])).toBe('ok');
    expect(rollUp([{ status: 'ok' }, { status: 'degraded' }])).toBe('degraded');
    expect(rollUp([{ status: 'degraded' }, { status: 'down' }])).toBe('down');
  });
});

describe('checkQueue', () => {
  it('reports cloud mode without probing when an event key is set', async () => {
    process.env.INNGEST_EVENT_KEY = 'signkey-prod-not-a-real-key';
    resetEnvCache();

    const result = await checkQueue();

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('cloud');
    // The honesty that matters: it must not claim to have checked something it
    // cannot check without spending a real API call.
    expect(result.probed).toBe(false);
  });

  it('reports down, with a pointer to `pnpm inngest:dev`, when the dev server is absent', async () => {
    delete process.env.INNGEST_EVENT_KEY;
    // Port 1 is reserved and nothing can be listening on it.
    process.env.INNGEST_DEV_URL = 'http://127.0.0.1:1';
    resetEnvCache();

    const result = await checkQueue();

    expect(result.status).toBe('down');
    expect(result.mode).toBe('dev');
    expect(result.probed).toBe(true);
    expect(result.error).toMatch(/inngest:dev/);
  });

  describe('against a stand-in dev server', () => {
    let server: Server;
    let status = 200;

    beforeEach(async () => {
      status = 200;
      server = createServer((req, res) => {
        res.writeHead(req.url === '/health' ? status : 404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      delete process.env.INNGEST_EVENT_KEY;
      process.env.INNGEST_DEV_URL = `http://127.0.0.1:${port}`;
      resetEnvCache();
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reports ok with a latency when /health answers', async () => {
      const result = await checkQueue();

      expect(result.status).toBe('ok');
      expect(result.probed).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('reports down when /health answers with an error status', async () => {
      status = 503;

      const result = await checkQueue();

      expect(result.status).toBe('down');
      expect(result.error).toMatch(/503/);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('checkDatabase', () => {
  it('reaches the configured database', async () => {
    const result = await checkDatabase();

    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    await closeDb();
  });
});

describe('checkDatabase without a DATABASE_URL', () => {
  it('reports down rather than throwing, so the endpoint still answers', async () => {
    delete process.env.DATABASE_URL;
    resetEnvCache();
    await closeDb();

    const result = await checkDatabase();

    expect(result.status).toBe('down');
    expect(result.error).toBeTruthy();
  });
});
