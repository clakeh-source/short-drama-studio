import 'server-only';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import { env } from '@/lib/env';
import * as schema from './schema';

export * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * One pooled postgres.js connection per process. `prepare: false` is required
 * by Supabase's transaction pooler.
 */
const globalForDb = globalThis as unknown as {
  __sdsSql?: ReturnType<typeof postgres>;
  __sdsDb?: Database;
};

function connection() {
  globalForDb.__sdsSql ??= postgres(env().DATABASE_URL, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
  });
  return globalForDb.__sdsSql;
}

/**
 * Privileged handle. The connection role bypasses RLS, so this is for trusted
 * server-side work only (background jobs, migrations, admin tasks). Anything
 * acting on behalf of a signed-in user must go through `withUserDb`.
 */
export function db(): Database {
  globalForDb.__sdsDb ??= drizzle(connection(), { schema });
  return globalForDb.__sdsDb;
}

const uuidSchema = z.uuid();

/**
 * Runs `fn` inside a transaction that has assumed the `authenticated` role with
 * `auth.uid()` bound to `userId`, so every Postgres RLS policy in schema.ts
 * applies exactly as it would for a request coming through PostgREST.
 *
 * Both settings are transaction-local (`set_config(..., true)`), so they are
 * discarded when the transaction ends and the pooled connection is handed back.
 */
export async function withUserDb<T>(
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const uid = uuidSchema.parse(userId);
  const claims = JSON.stringify({ sub: uid, role: 'authenticated' });

  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    return fn(tx);
  });
}

/** Closes the pool. Tests and one-shot scripts call this; the app does not. */
export async function closeDb(): Promise<void> {
  if (globalForDb.__sdsSql) {
    await globalForDb.__sdsSql.end({ timeout: 5 });
    globalForDb.__sdsSql = undefined;
    globalForDb.__sdsDb = undefined;
  }
}
