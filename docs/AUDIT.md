# Codebase audit

Scope: the whole application as of `fceffd3` — 18.7k lines across `app/`, `components/`,
`lib/` and `scripts/`. Focus on the security boundaries (auth, tenancy, secrets), the
spend controls, and the correctness of the job pipeline.

Every finding has since been fixed in this branch, and each carries a note saying
how. The one exception is the last item under F5, which is a property of the
design rather than a defect — it is recorded, not changed.

## Health check

| Check | At `fceffd3` | After the fixes |
| --- | --- | --- |
| `pnpm typecheck` | clean | clean |
| `pnpm lint` | clean | clean |
| `pnpm build` | passes | passes |
| `pnpm test` | 332 passed, 50 skipped, **1 suite fails to collect** (see F4) | 368 passed, 57 skipped, 0 failed |

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

### F1 — The spend cap does not apply to any LLM route (high) — fixed

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

**Fixed.** `lib/ai/budget.ts` now owns an operation → output-budget table, which the
`lib/ai` modules import in place of their inline `maxTokens` literals, so the number the
cap reasons about is the number the request sends. `assertLlmBudget` prices one attempt at
the provider's own rate and throws a 402 when it would breach the cap; all seven routes
call it before touching a provider. `assertLlmBudgetTotal` covers `series/import`, which
screens *and* derives in one request — checking only the screen would have let a user pay
for a verdict on a script that then could not be imported.

The SSE routes needed the refusal to be a real HTTP status rather than an `error` frame
inside a 200, so `sseRoute` gained a `preflight` hook that runs after validation and before
the stream opens; anything it throws goes through the same `toErrorResponse` as every JSON
route. The client already surfaces `error.message` from a non-OK response, so the cap text
reaches the user unchanged.

A corrective retry inside `streamJson` can still carry one generation past the cap by a
single attempt — the same latitude a video job that is already running gets.

### F2 — `/api/inngest` fails open outside recognised production environments (medium) — fixed

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

**Fixed.** The polarity is now inverted and stated rather than inferred.
`lib/inngest/mode.ts` answers "is this a dev machine?" — true only for `NODE_ENV=development`
(what `next dev` sets, so the documented local workflow needs no extra configuration) or an
explicit `INNGEST_DEV=1`. Everything else, recognised or not, is cloud. The Inngest client
passes that as `isDev`, which the SDK treats as an explicit mode and stops guessing from
platform variables; `lib/env.ts` then refuses to hand out an environment at all when the
mode is not dev and `INNGEST_SIGNING_KEY` is unset, so a misconfigured deployment says which
variable is missing instead of quietly accepting unsigned POSTs.

One consequence worth knowing: an environment that used to be *guessed* as dev now needs
`INNGEST_EVENT_KEY` too, because the SDK requires one to send events in cloud mode. That is
a loud failure naming the variable, where the old behaviour was to post events at a local
dev server that was not there.

### F3 — `POST /api/episodes/[id]/render` answers about episodes the caller does not own (low-medium) — fixed

`app/api/episodes/[id]/render/route.ts:18` calls `activeRender(params.id)` — which uses the
privileged `db()` handle and takes no `userId` — *before* `buildEpisodeTimeline` does the
ownership check on line 27. When another user's episode has a render in flight, the caller
gets:

```json
{ "queued": false, "renderId": "<their render uuid>", "message": "A render is already running for this episode." }
```

An attacker needs a victim's episode UUID to exploit it, and gets back only a render UUID
and the existence of an in-flight render — but it is a cross-tenant answer from an endpoint
that is supposed to have none.

**Fixed.** The route now calls `loadEpisode(user.id, params.id)` first, which reads through
RLS and 404s on anything the caller does not own. That rather than simply hoisting
`buildEpisodeTimeline`: the timeline build establishes ownership too, but signs a URL per
asset on the way, and the double-click path should not pay for that just to be told a render
is already running.

### F4 — `pnpm test` is red on a clean checkout (low) — fixed

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

**Fixed.** The provider is now resolved by a `provider()` helper called inside each test,
so collection touches no credentials. `tests/live-providers.test.ts` still has the eager
shape; it passes only because its adapters happen not to validate in the constructor, and
it is worth converting the next time it is touched.

### F5 — Minor issues — fixed

- **`POST /api/series/[id]/music` leaked internal error text.** Its hand-written catch
  returned `String(error.message)` for anything it caught, so a database or storage failure
  handed its message to the client under an HTTP 500 — the one route that escaped
  `toErrorResponse`, which exists to stop exactly that. It also awaited `request.formData()`,
  buffering the whole body, before checking the 20MB limit.
  **Fixed.** It runs on `dynamicRoute` now: the wrapper only touches the body when a Zod
  schema is configured, so a multipart route can use it and still read the form itself. The
  declared `content-length` is checked before the body is buffered, and `file.size` is still
  checked afterwards, because the header can lie.
- **`POST /api/script-import/parse` had no bound on the JSON path.** The upload path capped
  at 2MB; the `{ text }` path took an arbitrarily large string and handed it to a regex pass
  over every line.
  **Fixed.** `MAX_PASTED_CHARS` applies the same ceiling to pasted text, with a message that
  says what the limit is.
- **The episode-level idempotency key was inert.** `episodeGenerateEventId` documented that
  a double-clicked Generate "cannot enqueue the episode twice", but it fell back to
  `Date.now()` and its only caller minted a fresh `episode-<id>-<Date.now()>` header on every
  click — so no two requests ever shared a key and the dedup never once applied. No double
  spend occurred, because the per-shot event ids dedup during fan-out; the stated guarantee
  was simply not the one being provided.
  **Fixed.** `shotSetFingerprint` hashes the shots a request would enqueue, each with the
  attempt it would run as. Two clicks on the same pending shots are one event; a retry
  advances an attempt, which changes the fingerprint and goes through. The client no longer
  sends a per-click header, and an explicit `idempotency-key` still wins for callers that
  want to pin a retry themselves.
- **SSE routes returned a 500 with an "unauthorized" body.** Any non-`UnauthorizedError`
  failure got status 500 and the "Not signed in" envelope, so a client branching on the body
  was told to sign in again for what may have been the auth server being unreachable.
  **Fixed.** The wrapper hands the error to `toErrorResponse`, the same mapper every JSON
  route uses.
- **No security response headers.**
  **Fixed.** `next.config.ts` sets the fixed ones — `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and HSTS. The CSP carries
  a per-request nonce, so it is built in `lib/security-headers.ts` and set in middleware,
  which also forwards the nonce to Next's renderer. `script-src` is `'self' 'nonce-…'
  'strict-dynamic'` — no `'unsafe-inline'`, which is the point of doing it with a nonce at
  all; `connect-src` and `media-src` name this deployment's own Supabase origin, read from
  the environment rather than hardcoded. `style-src` keeps `'unsafe-inline'`, which React's
  `style` attributes and Next's hydration require.
  Verified rather than assumed: against a production build, all 19 script tags on `/login`
  carried the nonce, and the page loaded and hydrated in Chromium with no CSP violations.
- **No rate limiting.**
  **Fixed.** `lib/rate-limit.ts` counts requests per user per operation in fixed windows,
  and `route`/`dynamicRoute`/`sseRoute` take a `rateLimit` rule. The counters live in
  Postgres (a new `rate_limits` table, RLS on with no policy, so only the privileged handle
  touches it) because the app is serverless and an in-process counter is per-instance —
  which is to say per concurrent request, under exactly the load a limiter is for. It never
  throws: if its own table is unreachable the request is allowed and the failure logged,
  because a limiter that takes the app down has done more damage than the traffic it was
  shaping.
  Declared on the thirteen routes that reach a provider or chew CPU. The read and poll
  routes deliberately go without: the generation UI polls them by design, and limiting them
  would break the thing the limit is meant to protect.
- **The spend cap is per-user but configured globally.** `MAX_MONTHLY_SPEND_CENTS` is one
  env value applied to each user independently, so total exposure is *users × cap*, not
  `cap`. **Left as is** — this is what a per-user cap means, not a defect, and it is correct
  for a single-operator deployment. It is written down here because it is the thing to
  revisit before opening signups, where the missing control is a global ceiling rather than
  a per-user one.

## What a follow-up should look at

Nothing here is outstanding. Two things this pass deliberately did not do, for
whoever picks it up next:

- **`tests/live-providers.test.ts` still builds its providers eagerly.** It passes
  only because those adapters happen not to validate credentials in the
  constructor — the same shape that made F4 fail. Worth converting the next time
  it is touched.
- **A corrective retry inside `streamJson` can carry one generation a single
  attempt past the spend cap**, the same latitude a video job already running
  gets. Closing it means checking the cap per attempt rather than per request,
  which is a different design decision rather than a fix.
