# Codebase audit

Scope: the whole application as of `fceffd3` — 18.7k lines across `app/`, `components/`,
`lib/` and `scripts/`. Focus on the security boundaries (auth, tenancy, secrets), the
spend controls, and the correctness of the job pipeline.

Nothing in this document has been fixed; it is a read of the code as it stands.

## Health check

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | 332 passed, 50 skipped, **1 suite fails to collect** (see F4) |

## What holds up well

These are load-bearing and worth not regressing:

- **Tenancy is enforced in Postgres, not in application `WHERE` clauses.** `withUserDb`
  (`lib/db/index.ts:52`) assumes the `authenticated` role with `request.jwt.claims`
  bound transaction-locally, so every RLS policy in `lib/db/schema.ts` applies exactly
  as it would through PostgREST. A forgotten filter in a query is not a data leak.
- **Every route input is validated.** `route`/`dynamicRoute`/`sseRoute` make Zod parsing,
  session checks, structured logging and the error envelope structural rather than
  optional — a handler cannot skip them without not using the wrapper.
- **Secrets cannot reach the browser by accident.** `scripts/check-secrets.mjs` runs as
  part of `pnpm build` and enforces three separate properties, including "no secret has a
  value in the committed `.env.example`".
- **Storage is private, playback is signed**, and the service-role client is confined to
  `lib/storage.ts` and job code.
- **Provider charges are idempotent.** `recordUsage`'s `idempotencyKey` plus the
  `onConflictDoNothing` target means a re-executed Inngest step cannot double-charge.
- **`spawn` is used without a shell** in the ffmpeg adapter, and the magic-link `next`
  parameter is constrained to a same-origin path — no command injection, no open redirect.

## Findings

### F1 — The spend cap does not apply to any LLM route (high)

`MAX_MONTHLY_SPEND_CENTS` is documented in `.env.example:93` as "Generation refuses to
enqueue past it", and `lib/spend.ts` calls itself "the hard spend ceiling". It is checked
on exactly four routes: episode generate, shot generate, render, and voice preview.

Every route that spends Anthropic tokens checks nothing:

| Route | Spends on | Cap checked |
| --- | --- | --- |
| `POST /api/series` | safety screen | no |
| `POST /api/series/[id]/bible` | full bible | no |
| `POST /api/episodes/[id]/script` | full script (32k tokens) | no |
| `POST /api/episodes/[id]/scenes/[index]` | scene rewrite | no |
| `POST /api/episodes/[id]/storyboard` | full storyboard | no |
| `POST /api/episodes/[id]/export-copy` | caption + hashtags | no |
| `POST /api/series/import` | safety screen + bible derivation | no |

Each records its spend to `usage_log` afterwards, so the dashboard shows the money going
out — it simply never refuses. A signed-in user can hold the cap at any multiple of itself
by looping "regenerate script", and the video/render routes will keep refusing while the
LLM routes keep spending.

The fix is mechanical: `checkSpend` before the provider call, using the provider's own
estimate, and `throw paymentRequired(...)` — the same three lines the video path already
has. The SSE routes need the check before the stream opens so the client gets a 402 status
rather than an `error` frame.

### F2 — `/api/inngest` fails open outside recognised production environments (medium)

`INNGEST_SIGNING_KEY` is `.optional()` in `lib/env.ts:51`, and `/api/inngest` is on the
middleware's `PUBLIC_PATHS` allowlist, so nothing in this repo requires it to be set.

Inngest itself decides whether to verify request signatures by *inferring* its mode
(`node_modules/inngest/helpers/env.js`): it only treats the deployment as "cloud" when one
of `NODE_ENV`/`VERCEL_ENV`/`CONTEXT`/`ENVIRONMENT` starts with `prod`, or a Netlify/Render/
Railway/Cloudflare/Deno marker is present. On Vercel this holds and a missing key fails
*closed*. Anywhere it does not — a self-hosted Node process started without
`NODE_ENV=production`, a plain container, a preview box — `validateSignature` returns
success unconditionally and the endpoint accepts any POST.

That endpoint invokes the job functions, and the job functions read and write through the
RLS-bypassing `db()` handle with `userId` taken from the event body. Ownership is
re-verified per shot (`loadShotForJob`), which limits the blast radius considerably, but an
unauthenticated caller can still drive the pipeline and the provider spend that goes with it.

Fix: require `INNGEST_SIGNING_KEY` when `NODE_ENV === 'production'` in the env schema, and
pass `isDev: false` / an explicit mode to `serve()` rather than relying on inference.

### F3 — `POST /api/episodes/[id]/render` answers about episodes the caller does not own (low-medium)

`app/api/episodes/[id]/render/route.ts:18` calls `activeRender(params.id)` — which uses the
privileged `db()` handle and takes no `userId` — *before* `buildEpisodeTimeline` does the
ownership check on line 27. When another user's episode has a render in flight, the caller
gets:

```json
{ "queued": false, "renderId": "<their render uuid>", "message": "A render is already running for this episode." }
```

An attacker needs a victim's episode UUID to exploit it, and gets back only a render UUID
and the existence of an in-flight render — but it is a cross-tenant answer from an endpoint
that is supposed to have none. Moving the `activeRender` call below `buildEpisodeTimeline`
fixes it with no behaviour change for legitimate callers.

### F4 — `pnpm test` is red on a clean checkout (low)

`tests/live-anthropic.test.ts` gates its tests with `describe.skipIf(!live)`, but calls
`getLlmProvider('anthropic')` in the `describe` body (line 39), which Vitest evaluates at
collection time whether or not the suite is skipped. Without `ANTHROPIC_API_KEY` the
provider constructor throws and the suite fails to collect:

```
FAIL tests/live-anthropic.test.ts
Error: ANTHROPIC_API_KEY is not set.
```

So the documented free-and-offline `pnpm test` exits non-zero for anyone without a key —
including CI. `tests/live-providers.test.ts` has the same shape but its providers happen not
to validate credentials in the constructor, which is why only one suite is red.

Fix: resolve the provider lazily inside each `it`, or behind a helper the skipped suite
never calls.

### F5 — Minor issues

- **`POST /api/series/[id]/music` leaks internal error text.** Its hand-written catch
  (`route.ts:89-97`) returns `String(error.message)` for any error, so a database or storage
  failure surfaces its message to the client with an HTTP 500 — the one route that does not
  go through `toErrorResponse`, which exists precisely to prevent that. It also awaits
  `request.formData()` (buffering the whole body) before checking the 20MB limit.
- **`POST /api/script-import/parse` has no bound on the JSON path.** The upload path caps at
  2MB (`MAX_UPLOAD_BYTES`); the `{ text }` path accepts an arbitrarily large string and
  hands it straight to the regex-heavy `parseScriptText`. A `z.string().max(…)` closes it.
- **The episode-level idempotency key is inert.** `episodeGenerateEventId` documents that a
  double-clicked Generate "cannot enqueue the episode twice", but the only caller
  (`components/generation/generation-panel.tsx:115`) mints
  `episode-${id}-${Date.now()}` fresh on every click, so no two requests ever share a key.
  The protection that actually works is the per-shot `shotVideoEventId(shotId, attempt)`
  dedup during fan-out — no double spend occurs, but the comment describes a guarantee the
  code does not provide. Either derive the key from something stable or drop the claim.
- **SSE routes return a 500 with an "unauthorized" body.** `lib/api/sse.ts:62-66` maps any
  non-`UnauthorizedError` failure to status 500 while sending the "Not signed in" envelope,
  so a client branching on the body sees an auth failure for what may be an infrastructure
  one.
- **No security response headers.** `next.config.ts` sets no CSP, HSTS, `X-Frame-Options`,
  `X-Content-Type-Options` or `Referrer-Policy`. A `headers()` block is cheap here — the app
  loads no third-party scripts, so a strict CSP would not fight anything.
- **No rate limiting anywhere.** Every route is one authenticated request away from a
  provider call. This is what makes F1 expensive rather than merely untidy.
- **The spend cap is per-user but configured globally.** `MAX_MONTHLY_SPEND_CENTS` is one
  env value applied to each user independently, so total exposure is *users × cap*, not
  `cap`. Fine for a single-operator deployment; worth knowing before opening signups.

## Suggested order

1. F1 — the cap is the app's only cost control, and a third of the spending surface is outside it.
2. F4 — a red default test run devalues every other check in the repo.
3. F3, then F2 — both are small, bounded diffs.
4. F5 — batch them.
