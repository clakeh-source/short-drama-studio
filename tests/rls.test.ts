import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db, withUserDb } from '@/lib/db';
import { episodes, series } from '@/lib/db/schema';

/**
 * Phase 0 AC #4 — Row Level Security.
 *
 * Proves that a user acting as `authenticated` with their own `auth.uid()`
 * cannot read, write or delete another user's rows, even though the query
 * itself carries no WHERE clause on user_id. The isolation must come from the
 * Postgres policies in lib/db/schema.ts, not from application code.
 *
 * Requires a real Supabase database: set DATABASE_URL and run `pnpm db:push`
 * first. Without it the suite skips rather than passing vacuously.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Postgres reports an RLS write refusal as SQLSTATE 42501. Drizzle wraps the
 * driver error, so the code lives on `.cause`, not on the thrown error — an
 * assertion against the top-level message only ever sees "Failed query: …" and
 * would pass for *any* failure, including a typo in the test.
 */
const RLS_VIOLATION = '42501';

async function expectRlsRefusal(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, 'the write should have been refused').toBeDefined();

  let current: unknown = thrown;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: string; message?: string };
    if (candidate.code === RLS_VIOLATION) {
      expect(candidate.message).toMatch(/row-level security/i);
      return;
    }
    current = (current as { cause?: unknown }).cause;
  }

  throw new Error(
    `Expected SQLSTATE ${RLS_VIOLATION} (row-level security) somewhere in the error chain, ` +
      `but got: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
  );
}

const userA = crypto.randomUUID();
const userB = crypto.randomUUID();

let seriesA: string;
let seriesB: string;
let episodeB: string;

describe.skipIf(!hasDatabase)('RLS: cross-user isolation', () => {
  beforeAll(async () => {
    // Seeded through the privileged connection, which bypasses RLS on purpose:
    // the test needs two users' rows to exist before it can prove separation.
    const [a] = await db()
      .insert(series)
      .values({ userId: userA, title: 'A: Penthouse Revenge', logline: 'hers' })
      .returning({ id: series.id });
    const [b] = await db()
      .insert(series)
      .values({ userId: userB, title: 'B: The Substitute Heir', logline: 'theirs' })
      .returning({ id: series.id });

    seriesA = a!.id;
    seriesB = b!.id;

    const [ep] = await db()
      .insert(episodes)
      .values({ seriesId: seriesB, number: 1, title: 'B ep 1' })
      .returning({ id: episodes.id });
    episodeB = ep!.id;
  });

  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, userA));
    await db().delete(series).where(eq(series.userId, userB));
    await closeDb();
  });

  it('binds auth.uid() to the acting user inside withUserDb', async () => {
    const uid = await withUserDb(userA, async (tx) => {
      const rows = await tx.execute<{ uid: string }>(sql`select auth.uid()::text as uid`);
      return rows[0]?.uid;
    });
    expect(uid).toBe(userA);
  });

  it('returns only the acting user’s series — the other user’s row is invisible', async () => {
    const rows = await withUserDb(userA, (tx) => tx.select().from(series));

    expect(rows.map((r) => r.id)).toEqual([seriesA]);
    expect(rows.some((r) => r.userId === userB)).toBe(false);
  });

  it('returns zero rows when directly selecting another user’s series by id', async () => {
    const rows = await withUserDb(userA, (tx) =>
      tx.select().from(series).where(eq(series.id, seriesB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot update another user’s series', async () => {
    const updated = await withUserDb(userA, (tx) =>
      tx
        .update(series)
        .set({ title: 'hijacked' })
        .where(eq(series.id, seriesB))
        .returning({ id: series.id }),
    );
    expect(updated).toHaveLength(0);

    const [row] = await db().select().from(series).where(eq(series.id, seriesB));
    expect(row?.title).toBe('B: The Substitute Heir');
  });

  it('cannot delete another user’s series', async () => {
    const deleted = await withUserDb(userA, (tx) =>
      tx.delete(series).where(eq(series.id, seriesB)).returning({ id: series.id }),
    );
    expect(deleted).toHaveLength(0);

    const rows = await db().select().from(series).where(eq(series.id, seriesB));
    expect(rows).toHaveLength(1);
  });

  it('cannot insert a series owned by someone else', async () => {
    await expectRlsRefusal(
      withUserDb(userA, (tx) =>
        tx.insert(series).values({ userId: userB, title: 'planted', logline: '' }),
      ),
    );
  });

  it('isolates child tables through the join up to series.user_id', async () => {
    const rows = await withUserDb(userA, (tx) =>
      tx.select().from(episodes).where(eq(episodes.id, episodeB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot attach a child row to another user’s series', async () => {
    await expectRlsRefusal(
      withUserDb(userA, (tx) =>
        tx.insert(episodes).values({ seriesId: seriesB, number: 99, title: 'planted' }),
      ),
    );
  });

  it('still lets the acting user read and write their own rows', async () => {
    const inserted = await withUserDb(userA, async (tx) => {
      const [ep] = await tx
        .insert(episodes)
        .values({ seriesId: seriesA, number: 1, title: 'A ep 1' })
        .returning({ id: episodes.id });

      const found = await tx
        .select()
        .from(episodes)
        .where(and(eq(episodes.seriesId, seriesA), eq(episodes.number, 1)));

      return { id: ep?.id, found: found.length };
    });

    expect(inserted.id).toBeTruthy();
    expect(inserted.found).toBe(1);
  });
});

describe.skipIf(hasDatabase)('RLS suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('RLS tests skipped: set DATABASE_URL and run `pnpm db:push` to execute them.');
    expect(hasDatabase).toBe(false);
  });
});
