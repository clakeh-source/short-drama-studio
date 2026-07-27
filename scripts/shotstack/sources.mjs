/**
 * Row sources for the Shotstack batch renderer.
 *
 * A source hands back rows of merge-field values and remembers what has already
 * rendered, so an interrupted batch resumes by re-running the same command.
 * Both implementations satisfy:
 *
 *   {
 *     label,                       // for logging
 *     rows: [{ key, done, values }],  // values keyed by MERGE_FIELD
 *     record(row, outcome),        // persist status/renderId/url/error
 *     close(),
 *   }
 *
 * Column and header names map to merge fields by uppercasing, so `agent_name`
 * and `AGENT_NAME` both feed {{ AGENT_NAME }}.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ csv */

/** RFC 4180 parser: handles quoted fields, embedded commas, "" escapes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) =>
    Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])),
  );
}

function toCsv(rows, headers) {
  const esc = (v) => (/[",\n]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ''));
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

/** Slug of a value, unique-ified by the caller's `seen` map. */
function makeKey(value, fallback, seen) {
  const base =
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || fallback;
  const dupe = seen.get(base) ?? 0; // two rows can share an address
  seen.set(base, dupe + 1);
  return dupe ? `${base}-${dupe + 1}` : base;
}

const MANIFEST_COLUMNS = ['key', 'status', 'renderId', 'url', 'error'];

export function csvSource({ csv, outDir, keyColumn }) {
  const path = resolve(csv);
  if (!existsSync(path)) throw new Error(`CSV not found: ${path}`);

  const parsed = parseCsv(readFileSync(path, 'utf8'));
  if (!parsed.length) throw new Error(`${path} has a header but no data rows.`);

  const manifestPath = `${outDir}/manifest.csv`;
  const manifest = existsSync(manifestPath)
    ? Object.fromEntries(parseCsv(readFileSync(manifestPath, 'utf8')).map((r) => [r.key, r]))
    : {};

  const headers = Object.keys(parsed[0]);
  const keyHeader = keyColumn ?? headers[0];
  const seen = new Map();

  const rows = parsed.map((raw, i) => {
    const key = makeKey(raw[keyHeader], `row-${i + 1}`, seen);
    return {
      key,
      // CSV line number, so an error message points at something editable.
      origin: `line ${i + 2}`,
      done: manifest[key]?.status === 'done',
      values: Object.fromEntries(headers.map((h) => [h.toUpperCase(), raw[h]])),
      // Local paths are resolved relative to the CSV, not the cwd.
      baseDir: dirname(path),
    };
  });

  return {
    label: path,
    rows,
    async record(row, outcome) {
      manifest[row.key] = { key: row.key, ...outcome };
      writeFileSync(manifestPath, toCsv(Object.values(manifest), MANIFEST_COLUMNS));
    },
    async close() {},
  };
}

/* ------------------------------------------------------------- postgres */

/**
 * Default work queue. Aliases are quoted so Postgres preserves the case and the
 * column name *is* the merge field; `images` is an ordered array, so the
 * template's five image slots come off the front of it.
 */
const LISTINGS_QUERY = `
  select id,
         address                as "ADDRESS",
         suburb                 as "SUBURB",
         state                  as "STATE",
         postcode               as "POSTCODE",
         listing_type           as "TYPE",
         bedrooms::text         as "BEDROOMS",
         bathrooms::text        as "BATHROOMS",
         carports::text         as "CARPORTS",
         images[1]              as "IMAGE_1",
         images[2]              as "IMAGE_2",
         images[3]              as "IMAGE_3",
         images[4]              as "IMAGE_4",
         images[5]              as "IMAGE_5",
         agent_name             as "AGENT_NAME",
         agent_email            as "AGENT_EMAIL",
         agent_picture          as "AGENT_PICTURE",
         agency_logo            as "AGENCY_LOGO",
         rendered_at
  from listings
  order by created_at
`;

/** Columns that carry bookkeeping rather than merge values. */
const RESERVED = new Set(['ID', 'RENDERED_AT', 'VIDEO_URL', 'SHOTSTACK_RENDER_ID', 'RENDER_ERROR']);

export async function postgresSource({ query, table, user, keyColumn, writeBack }) {
  const { config } = await import('dotenv');
  config({ path: '.env.local', quiet: true });
  config({ path: '.env', quiet: true });

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (looked in the environment, .env.local, .env)');

  const { default: postgres } = await import('postgres');
  // prepare:false is required by Supabase's transaction pooler, same as lib/db.
  const sql = postgres(url, { prepare: false, max: 4, idle_timeout: 20 });

  let raw;
  try {
    raw = query
      ? await sql.unsafe(query)
      : user
        ? await sql.unsafe(LISTINGS_QUERY.replace('from listings', 'from listings where user_id = $1'), [user])
        : await sql.unsafe(LISTINGS_QUERY);
  } catch (err) {
    await sql.end();
    throw err;
  }

  if (!raw.length) {
    await sql.end();
    throw new Error(
      query ? 'query returned no rows' : `no rows in "${table}"${user ? ` for user ${user}` : ''}`,
    );
  }

  const columns = Object.keys(raw[0]);
  const valueColumns = columns.filter((c) => !RESERVED.has(c.toUpperCase()));
  const keyCol = keyColumn ?? valueColumns[0];
  const seen = new Map();

  const rows = raw.map((record, i) => ({
    key: makeKey(record[keyCol], `row-${i + 1}`, seen),
    origin: record.id ? `${table}.id ${record.id}` : `row ${i + 1}`,
    id: record.id,
    done: Boolean(record.rendered_at),
    values: Object.fromEntries(
      valueColumns.map((c) => [c.toUpperCase(), record[c] == null ? '' : String(record[c])]),
    ),
    baseDir: process.cwd(),
  }));

  // Writing back needs a primary key to target. A custom --query that doesn't
  // select one still renders; it just can't record the result.
  const canWriteBack = writeBack && rows.every((r) => r.id);
  if (writeBack && !canWriteBack) {
    console.warn(`⚠ query does not select an "id" column — results will not be written back`);
  }

  return {
    label: `postgres ${query ? '(custom query)' : table}`,
    rows,
    async record(row, outcome) {
      if (!canWriteBack || outcome.status === 'validated') return; // dry runs record nothing
      const done = outcome.status === 'done';
      await sql.unsafe(
        `update ${table} set shotstack_render_id = $1, video_url = $2,
                             rendered_at = $3, render_error = $4, updated_at = now()
         where id = $5`,
        [
          outcome.renderId || null,
          outcome.url || null,
          done ? new Date() : null,
          done ? null : outcome.error || null,
          row.id,
        ],
      );
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
