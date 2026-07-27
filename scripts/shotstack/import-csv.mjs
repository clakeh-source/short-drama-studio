#!/usr/bin/env node
/**
 * Loads a listings CSV into the `listings` table, so rows that started life in a
 * spreadsheet (or a CRM export) become the renderer's Postgres work queue.
 *
 *   node scripts/shotstack/import-csv.mjs --user <uuid> [--csv listings.csv]
 *
 * Idempotent on (user_id, address): re-importing updates the listing in place
 * and leaves its render state alone, so re-running never re-renders anything.
 * Pass --reset-renders to clear that state and queue the rows again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { parseCsv } from './sources.mjs';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)(?:[= ](?!--)([^\s]+))?/g)
    .map((m) => [m[1], m[2] ?? true]),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(args.csv ?? `${HERE}/listings.csv`);
const USER = args.user;

if (!USER) {
  console.error('--user <uuid> is required (the owner the RLS policy checks).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
if (!rows.length) {
  console.error(`${CSV} has no data rows.`);
  process.exit(1);
}

const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let inserted = 0;
let updated = 0;

try {
  for (const row of rows) {
    const images = [row.IMAGE_1, row.IMAGE_2, row.IMAGE_3, row.IMAGE_4, row.IMAGE_5].filter(Boolean);

    // No unique constraint on (user_id, address) — a user may legitimately have
    // two listings at one address — so match explicitly rather than upsert.
    const [existing] = await sql`
      select id from listings where user_id = ${USER} and address = ${row.ADDRESS} limit 1
    `;

    const values = {
      user_id: USER,
      address: row.ADDRESS,
      suburb: row.SUBURB ?? '',
      state: row.STATE ?? '',
      postcode: row.POSTCODE ?? '',
      listing_type: row.TYPE || 'FOR SALE',
      bedrooms: int(row.BEDROOMS),
      bathrooms: int(row.BATHROOMS),
      carports: int(row.CARPORTS),
      images,
      agent_name: row.AGENT_NAME ?? '',
      agent_email: row.AGENT_EMAIL ?? '',
      agent_picture: row.AGENT_PICTURE ?? '',
      agency_logo: row.AGENCY_LOGO ?? '',
    };

    if (existing) {
      await sql`update listings set ${sql(values)}, updated_at = now() where id = ${existing.id}`;
      if (args['reset-renders']) {
        await sql`
          update listings
             set shotstack_render_id = null, video_url = null,
                 rendered_at = null, render_error = null
           where id = ${existing.id}
        `;
      }
      updated++;
    } else {
      await sql`insert into listings ${sql(values)}`;
      inserted++;
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}

console.log(`${inserted} inserted, ${updated} updated from ${CSV}`);
