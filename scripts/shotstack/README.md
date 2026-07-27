# Shotstack batch renders

Renders one video per data row from the saved template
`a0fd01a7-6565-4447-870c-492ad1eccc37` (real-estate slideshow, 36s, 1024×576).

Rows come from **Postgres** by default; CSV is still supported with `--csv`.

```sh
export SHOTSTACK_API_KEY=...           # or: shotstack login
                                       # DATABASE_URL is read from .env.local

pnpm shotstack:batch --dry-run         # build + validate every row, no credits
pnpm shotstack:batch                   # render everything not already rendered
pnpm shotstack:batch --limit 1         # smoke-test one row first
```

## The `listings` table

Added in `drizzle/0004_icy_energizer.sql`, defined in `lib/db/schema.ts`. Column
names are the template's merge fields lowercased — the renderer maps them by
uppercasing, so `agent_name` feeds `{{ AGENT_NAME }}`. Two columns don't follow
that rule: `listing_type` maps to `{{ TYPE }}`, and `images` is an ordered
`text[]` whose first five entries fill `IMAGE_1`…`IMAGE_5`.

RLS is enabled with the same owner policy shape as `series`, so rows are scoped
by `user_id`. The scripts connect with the pooler role, which bypasses RLS —
they're trusted server-side jobs, like the Inngest workers.

Four columns hold render state, and they *are* the resume log:

| Column | |
|---|---|
| `shotstack_render_id` | the API's render id |
| `video_url` | the finished MP4 |
| `rendered_at` | non-null ⇒ done, so the row is skipped next run |
| `render_error` | last failure, cleared on success |

Each row is written back the moment it finishes, so a batch killed halfway
resumes correctly by re-running the same command.

### Getting rows in

From a CSV (idempotent on `user_id` + `address`; re-import updates in place and
leaves render state alone):

```sh
pnpm shotstack:import --user <uuid> --csv scripts/shotstack/listings.csv
pnpm shotstack:import --user <uuid> --reset-renders   # also re-queue them
```

Or insert however you like — the renderer only reads the table.

### Querying something else

`--query` runs arbitrary SQL, so a view, a join, or a different table works
without touching the script. Alias each column to its merge field (quoted, to
keep the case):

```sh
pnpm shotstack:batch --query 'select id, street as "ADDRESS", … from crm_export'
```

Rows are written back only when the query selects an `id` **and** you name the
target with `--table`; otherwise the run is read-only and says so. `--user
<uuid>` filters the default query to one owner.

## Flags

| Flag | Default | |
|---|---|---|
| `--csv <path>` | — | read a CSV instead of Postgres |
| `--table <name>` | `listings` | table to read and write back |
| `--query <sql>` | — | arbitrary SQL instead of the default queue |
| `--user <uuid>` | — | filter the default query by owner |
| `--key <column>` | first column | what names the output file / log line |
| `--template <id>` | the id above | any saved template |
| `--env <name>` | `v1` | `stage` renders free with a watermark |
| `--concurrency <n>` | `3` | renders in flight |
| `--limit <n>` | all | cap this run |
| `--dry-run` | off | build + validate only, no credits |
| `--strict` | off | treat validation warnings as failures |
| `--force` | off | re-render rows already done |
| `--no-write-back` | off | never update the source table |
| `--refresh-template` | off | re-fetch the template from the API |

## Output

`out/` (git-ignored) keeps the debugging trail:

| Path | What |
|---|---|
| `edits/<key>.json` | the exact Edit JSON submitted |
| `.template-<id>.json` | cached template; refresh with `--refresh-template` |
| `.ingest-cache.json` | uploaded local files, keyed by content stamp |
| `manifest.csv` | CSV mode only — the resume log Postgres mode keeps in-table |

Image values may be **local paths as well as URLs** (resolved relative to the CSV
in CSV mode, to the cwd in Postgres mode). A path is uploaded via the Ingest API
and the hosted URL cached, so re-runs don't re-upload.

## Two quirks worth knowing

Both are handled in the script; this is why the code looks the way it does.

1. **Merge is applied locally, not by the API.** Substituting `{{ FIELD }}`
   before submitting means `shotstack validate` lints the *real* values, so a
   broken image URL fails offline instead of burning a credit.

2. **Renders are POSTed to the API directly, not via `shotstack render`.** The
   CLI runs the offline linter before submitting, and that linter flags this
   template's agent-card track as a same-track clip overlap. It isn't one: a
   luma matte is *required* to share a track with the clip it masks and to
   overlap it in time. The script suppresses that specific finding (and only on
   tracks that actually contain a luma asset — genuine overlaps still fail the
   row), then submits over HTTP. Polling still goes through `shotstack status
   --watch`.
