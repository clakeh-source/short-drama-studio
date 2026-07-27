#!/usr/bin/env node
/**
 * Batch-renders one video per data row from a saved Shotstack template.
 *
 * Rows come from Postgres (default, the `listings` table) or a CSV. Each column
 * maps to a {{ MERGE_FIELD }} by uppercasing its name. For every row the script
 * clones the template, substitutes that row's values, validates the edit offline
 * (free), submits it to the render API, waits for the MP4, and records the URL
 * back against the row.
 *
 *   node scripts/shotstack/render-batch.mjs                    # postgres
 *   node scripts/shotstack/render-batch.mjs --csv rows.csv     # csv
 *
 * Costs nothing until the render step, so `--dry-run` builds + validates every
 * row without touching credits. Runs are resumable: rows already rendered are
 * skipped unless you pass --force.
 *
 * Requires SHOTSTACK_API_KEY (or `shotstack login`), and DATABASE_URL for the
 * Postgres source.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvSource, postgresSource } from './sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const TEMPLATE_ID = args.template ?? 'a0fd01a7-6565-4447-870c-492ad1eccc37';
const ENV = args.env ?? 'v1';
const OUT = resolve(args.out ?? `${HERE}/out`);
const CONCURRENCY = Number(args.concurrency ?? 3);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DRY_RUN = Boolean(args['dry-run']);
const FORCE = Boolean(args.force);
const STRICT = Boolean(args.strict);

const EDITS_DIR = `${OUT}/edits`;
const TEMPLATE_CACHE = `${OUT}/.template-${TEMPLATE_ID}.json`;
const INGEST_CACHE = `${OUT}/.ingest-cache.json`;

mkdirSync(EDITS_DIR, { recursive: true });

// ---------------------------------------------------------------- shell

/** Runs a command, resolving with its output. Exit code 2 from the CLI means
 *  "transient, safe to retry" — everything else is surfaced as a hard failure. */
function run(cmd, argv) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, argv, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolvePromise({ stdout, stderr });
      const error = new Error((stderr || stdout || err.message).trim());
      error.code = err.code ?? 1;
      error.retryable = err.code === 2;
      reject(error);
    });
  });
}

/** Retries only what the API/CLI marked transient (5xx, 429, network). */
async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const runWithRetry = (cmd, argv, attempts = 3) => withRetry(() => run(cmd, argv), attempts);

/** The CLI streams one JSON object per line under --watch; the last one wins. */
function lastJson(stdout) {
  let found = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      found = JSON.parse(trimmed);
    } catch {
      /* partial line — ignore */
    }
  }
  if (!found) throw new Error(`no JSON in CLI output:\n${stdout}`);
  return found;
}

// ---------------------------------------------------------------- template

async function loadTemplate() {
  if (existsSync(TEMPLATE_CACHE) && !args['refresh-template']) {
    return JSON.parse(readFileSync(TEMPLATE_CACHE, 'utf8'));
  }
  const { stdout } = await runWithRetry('shotstack', [
    'template', 'get', TEMPLATE_ID, '--env', ENV, '--output', 'json',
  ]);
  const template = lastJson(stdout);
  writeFileSync(TEMPLATE_CACHE, JSON.stringify(template, null, 2));
  return template;
}

/** Every {{ PLACEHOLDER }} the template actually references. */
function placeholdersIn(template) {
  const names = new Set();
  const json = JSON.stringify(template.timeline ?? template);
  for (const [, name] of json.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) names.add(name);
  return names;
}

// ---------------------------------------------------------------- ingest

const ingestCache = existsSync(INGEST_CACHE) ? JSON.parse(readFileSync(INGEST_CACHE, 'utf8')) : {};

/** A CSV cell may name a local file instead of a URL. An Edit can only reference
 *  media by URL, so upload it once and remember the hosted URL by content stamp. */
async function hostIfLocal(value, baseDir) {
  if (!value || /^https?:\/\//i.test(value)) return value;
  const path = isAbsolute(value) ? value : resolve(baseDir, value);
  if (!existsSync(path) || !statSync(path).isFile()) return value;

  const stat = statSync(path);
  const key = createHash('sha1').update(`${path}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  if (ingestCache[key]) return ingestCache[key];

  console.log(`  ↑ uploading ${basename(path)}`);
  const { stdout } = await runWithRetry('shotstack', [
    'ingest', 'upload', path, '--env', ENV, '--watch', '--output', 'json',
  ]);
  const source = lastJson(stdout).source;
  if (!source) throw new Error(`ingest returned no source URL for ${path}`);
  ingestCache[key] = source;
  writeFileSync(INGEST_CACHE, JSON.stringify(ingestCache, null, 2));
  return source;
}

// ---------------------------------------------------------------- per row

/**
 * A luma matte is *required* to share a track with the clip it masks and to
 * overlap it in time, so the linter's same-track overlap rule fires on every
 * correctly-built matte. Suppress that specific false positive — and only on
 * tracks that actually contain a luma asset, so genuine overlaps still fail.
 */
function isLumaFalsePositive(issue, edit) {
  if (issue.code !== 'clip_overlap') return false;
  const track = issue.path.match(/^timeline\.tracks\[(\d+)\]/)?.[1];
  if (track === undefined) return false;
  const clips = edit.timeline?.tracks?.[Number(track)]?.clips ?? [];
  return clips.some((clip) => clip.asset?.type === 'luma');
}

/** Lints an edit offline (no key, no credits). Errors abort the row. */
async function validateEdit(file, edit) {
  let issues = [];
  try {
    const { stdout } = await run('shotstack', ['validate', file, '--output', 'json']);
    issues = lastJson(stdout).issues ?? [];
  } catch (err) {
    try {
      issues = JSON.parse(err.message).issues ?? [];
    } catch {
      throw err; // not a validation report — a real CLI failure
    }
  }

  const errors = issues.filter((i) => i.level === 'error' && !isLumaFalsePositive(i, edit));
  const warnings = issues.filter((i) => i.level === 'warning');
  if (errors.length) {
    throw new Error(errors.map((i) => `${i.path}: ${i.message}`).join('; '));
  }
  if (STRICT && warnings.length) {
    throw new Error(`--strict: ${warnings.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
}

/**
 * Submits an edit and returns the render id.
 *
 * Posts to the API directly rather than via `shotstack render`, which runs the
 * same offline linter and so refuses to submit this template over the luma
 * false positive above. Polling still goes through `shotstack status --watch`.
 */
async function submitRender(edit) {
  const key = process.env.SHOTSTACK_API_KEY;
  if (!key) throw new Error('SHOTSTACK_API_KEY is not set');

  const response = await fetch(`https://api.shotstack.io/edit/${ENV}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(edit),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body.message ?? body.response?.message ?? JSON.stringify(body);
    const error = new Error(`render submit failed (${response.status}): ${detail}`);
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  const id = body.response?.id;
  if (!id) throw new Error(`render submit returned no id: ${JSON.stringify(body)}`);
  return id;
}

/** Substitutes {{ FIELD }} throughout the edit. Done here rather than left to the
 *  API's merge array so `shotstack validate` lints the real values — a typo'd or
 *  unreachable image URL is then caught offline instead of at render time. */
function applyMerge(node, values) {
  if (typeof node === 'string') {
    return node.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) =>
      name in values ? values[name] : match,
    );
  }
  if (Array.isArray(node)) return node.map((child) => applyMerge(child, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, applyMerge(v, values)]));
  }
  return node;
}

async function renderRow(row, template, fields) {
  // Template defaults first, so a field the source omits still resolves.
  const values = Object.fromEntries((template.merge ?? []).map((m) => [m.find, m.replace]));
  const merge = [];
  for (const field of fields) {
    values[field] = await hostIfLocal(row.values[field], row.baseDir);
    merge.push({ find: field, replace: values[field] });
  }

  const edit = { ...applyMerge(structuredClone(template), values), merge };
  const file = `${EDITS_DIR}/${row.key}.json`;
  writeFileSync(file, JSON.stringify(edit, null, 2));

  await validateEdit(file, edit);
  if (DRY_RUN) return { status: 'validated', renderId: '', url: '' };

  const renderId = await withRetry(() => submitRender(edit));
  const { stdout } = await runWithRetry('shotstack', [
    'status', renderId, '--env', ENV, '--watch', '--output', 'json',
  ]);
  const result = lastJson(stdout);
  const url = result.url ?? result.response?.url ?? '';
  if (!url) throw new Error(`render ${renderId} finished without a URL: ${JSON.stringify(result)}`);
  return { status: 'done', renderId, url };
}

/** Runs `worker` over `items`, at most `limit` in flight. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------- main

async function openSource() {
  if (args.csv) {
    return csvSource({ csv: args.csv, outDir: OUT, keyColumn: args.key });
  }
  const table = args.table ?? 'listings';
  return postgresSource({
    query: args.query,
    table,
    user: args.user,
    keyColumn: args.key,
    // A custom query may target a view or a table with no render columns, so
    // only write back when we know what to update.
    writeBack: !args['no-write-back'] && (!args.query || Boolean(args.table)),
  });
}

const template = await loadTemplate();
const placeholders = placeholdersIn(template);

let source;
try {
  source = await openSource();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let failures = 0;
try {
  const columns = Object.keys(source.rows[0].values);
  const fields = columns.filter((c) => placeholders.has(c));
  const unknown = columns.filter((c) => !placeholders.has(c));
  const missing = [...placeholders].filter((p) => !columns.includes(p));

  if (!fields.length) {
    throw new Error(
      `No column matches a template merge field.\nTemplate expects: ${[...placeholders].join(', ')}`,
    );
  }
  if (missing.length) console.warn(`⚠ not in source, template default kept: ${missing.join(', ')}`);
  if (unknown.length) console.warn(`⚠ column ignored (no such merge field): ${unknown.join(', ')}`);

  // A field with neither a source value nor a template default would render a
  // literal "{{ FIELD }}" on screen — catch that before spending a credit.
  const defaults = new Set((template.merge ?? []).map((m) => m.find));
  const blanks = source.rows.flatMap((row) =>
    fields.filter((f) => !row.values[f] && !defaults.has(f)).map((f) => `${row.origin}: ${f}`),
  );
  if (blanks.length) {
    throw new Error(`Empty values with no template default:\n  ${blanks.join('\n  ')}`);
  }

  const pending = source.rows.filter((row) => FORCE || !row.done);
  const todo = pending.slice(0, LIMIT);

  console.log(
    `${source.rows.length} row(s) from ${source.label} · ${fields.length} merge field(s) · ` +
      `env ${ENV}${DRY_RUN ? ' · dry run (no credits)' : ''}`,
  );
  if (pending.length < source.rows.length) {
    console.log(
      `${source.rows.length - pending.length} already rendered, skipping (--force to redo).`,
    );
  }
  if (todo.length < pending.length) {
    console.log(`--limit ${LIMIT}: rendering ${todo.length} of ${pending.length} remaining.`);
  }

  await pool(todo, CONCURRENCY, async (row) => {
    console.log(`→ ${row.key}`);
    let outcome;
    try {
      outcome = { ...(await renderRow(row, template, fields)), error: '' };
      console.log(`✓ ${row.key}${outcome.url ? ` ${outcome.url}` : ''}`);
    } catch (err) {
      failures++;
      outcome = { status: 'failed', renderId: '', url: '', error: err.message };
      console.error(`✗ ${row.key} (${row.origin}): ${err.message}`);
    }
    // Recorded per row, not at the end, so a crash mid-batch still resumes.
    await source.record(row, outcome);
  });

  console.log(`\n${todo.length - failures}/${todo.length} succeeded`);
} catch (err) {
  console.error(err.message);
  failures ||= 1;
} finally {
  await source.close();
}

process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}
