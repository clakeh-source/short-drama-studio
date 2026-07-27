# Deploying Short Drama Studio

Target: **Vercel** for the app, **Inngest Cloud** for background jobs, the
existing **Supabase** project for auth, database and storage.

Read *Blockers* first. Three things must be bought or chosen before a deploy can
produce a finished episode, and none of them is a code change.

---

## Blockers

| What | State | Needed for |
|---|---|---|
| Replicate credit | account authenticates, **balance empty** (HTTP 402) | any video generation |
| `REPLICATE_VIDEO_MODEL` | **unset** | any video generation |
| `SHOTSTACK_API_KEY` | **unset** | assembling an episode into an MP4 |
| Vercel plan | must be **Pro** | see *Function limits* |

Everything else — auth, scripting, storyboarding, voice — works without them.
The Anthropic and ElevenLabs credentials are live and verified (see the README's
*Live verification*).

---

## Function limits: why Pro, not Hobby

This is the constraint that shapes the whole deployment.

Vercel's default function ceiling is **15s on Pro** and the hard cap on **Hobby
is 60s**. Measured generation times on this app:

| Route | Measured | Ceiling needed |
|---|---|---|
| `/api/series/[id]/bible` | ~38s at `effort: low` | 300s |
| `/api/episodes/[id]/script` | 32k-token budget, well past a minute | 300s |
| `/api/episodes/[id]/storyboard` | 32k-token budget, well past a minute | 300s |
| `/api/episodes/[id]/scenes/[index]` | one full model round trip | 300s |
| `/api/inngest` | bounded by the slowest step — clip download + Storage upload | 300s |
| `/api/voices/preview` | ~3s for a short line | 60s |

Each of those routes now declares its own `maxDuration`. **Hobby cannot raise
the cap past 60s**, so script and storyboard generation would be killed
mid-stream — the user watches text appear and then simply stop. Deploy to Pro.

## Region

`vercel.json` pins functions to `cdg1` (Paris).

The Supabase project is in **eu-west-3** (Paris). Vercel defaults to `iad1`
(US East), which puts a transatlantic round trip inside every database query —
and `withUserDb` is already 139ms locally because it wraps each query in a
transaction with two `set_config` calls. Co-locating removes ~80-90ms per query
from every page.

If you move the Supabase project, change this to match it.

---

## One-time setup

### 1. Supabase

The project (`ngdylofqpndlpkwpzgas`, eu-west-3) already has the schema, indexes
and RLS policies from Phase 0. Two things still need doing for a public origin:

**Auth redirect allowlist.** Dashboard → Authentication → URL Configuration:

- Site URL: `https://<your-domain>`
- Redirect URLs: add `https://<your-domain>/auth/callback`

Magic links break silently without this — the link lands on an error page rather
than signing the user in.

**Storage buckets.** Already created if you have run `pnpm db:buckets` against
this project. It is idempotent, so re-running is safe.

> **The 50MB ceiling is real.** `scripts/create-buckets.mjs` caps each bucket at
> 50MB because that is the Supabase free-tier project limit, and asking for more
> is rejected outright. A 60-second 1080x1920 H.264 render can exceed that. If
> exports start failing on size, raise the project limit on a paid plan and set
> `SUPABASE_FILE_SIZE_LIMIT` before re-running `pnpm db:buckets`.

### 2. Migrations

Run against the production database from a machine that has the credentials:

```bash
pnpm db:migrate
```

Never `db:push` — it crashes against Supabase. The README explains why under
*Use `db:migrate`, not `db:push`*.

### 3. Inngest Cloud

1. Create an app in Inngest Cloud.
2. Set its serve URL to `https://<your-domain>/api/inngest`.
3. Copy the **event key** and **signing key** into Vercel (below).
4. After the first deploy, trigger a sync from the Inngest dashboard so it
   discovers the five functions.

The `INNGEST_SIGNING_KEY` already in `.env.local` is a `signkey-prod-` key. Use
the keys from the Inngest app that actually serves this deployment; a mismatched
signing key makes every step request fail authentication.

### 4. Vercel

Create the project from the repo, then set environment variables. **Set them
yourself in the Vercel dashboard or via `vercel env add`** — never paste secrets
into a file that gets committed.

Required:

```
NEXT_PUBLIC_APP_URL=https://<your-domain>
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
DATABASE_URL=...            # transaction pooler, not the direct connection
ANTHROPIC_API_KEY=...
INNGEST_EVENT_KEY=...
INNGEST_SIGNING_KEY=...
MAX_MONTHLY_SPEND_CENTS=2000
```

Provider selection — note that **`ffmpeg` is not an option in production**:

```
LLM_PROVIDER=anthropic
TTS_PROVIDER=elevenlabs
VIDEO_PROVIDER=replicate    # or stub until Replicate has credit
RENDER_PROVIDER=shotstack   # ffmpeg throws on Vercel by design
```

Provider credentials, as far as they exist:

```
ELEVENLABS_API_KEY=...
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=wav_24000
ELEVENLABS_CENTS_PER_1K_CHARS=3

REPLICATE_API_TOKEN=...
REPLICATE_VIDEO_MODEL=...                  # see "Choosing a video model"
REPLICATE_VIDEO_DURATIONS=...              # must match the model's grid
REPLICATE_VIDEO_COST_CENTS_PER_SECOND=...  # the model's published rate

SHOTSTACK_API_KEY=...
SHOTSTACK_ENV=v1            # `stage` renders are watermarked and expire
```

`DATABASE_URL` must be the **transaction pooler** string. Serverless functions
open a connection per invocation; the direct connection exhausts the project's
limit under any real traffic.

`SHOTSTACK_ENV` defaults to `stage`. Leaving it there in production gives you
watermarked output that disappears after 24 hours.

### 5. Why `ffmpeg` is refused on Vercel

`FfmpegRenderProvider` throws at construction when `process.env.VERCEL` is set.
Two independent reasons, either of which is fatal:

- there is no ffmpeg binary in the runtime; and
- its job map is module-scope state, so `render()` and `poll()` can land on
  different instances and the handle resolves to "unknown job" — the same bug
  the stubs had before they moved to encoded handles.

Failing at selection rather than at render time means an episode cannot spend its
clips and only then discover it has nowhere to be assembled.

---

## Choosing a video model

`REPLICATE_VIDEO_MODEL` names the model; its duration grid, price and input
field names are properties of *that model*, and they differ. The README's
*Live verification* section has the comparison table. Two rules:

- **Pin the version** (`owner/name:version`). A model updated underneath you
  changes what every episode looks like.
- **Match `REPLICATE_VIDEO_DURATIONS` to the model's real grid**, because it is
  what the storyboard plans against.

`google/veo-3-fast` is the only candidate examined whose inputs match the
adapter's canonical set exactly. It is the safest first target.

Whether Replicate rejects an input a model does not declare, or ignores it, is
**still unverified** — the 402 fires before input validation, so the probe never
reached an answer. **Generate one shot before generating a board.**

---

## Deploy

```bash
vercel --prod
```

`pnpm build` runs `scripts/check-secrets.mjs` first, which fails the build if any
secret is reachable from the browser. Type errors and lint errors also fail the
build by design (`next.config.ts`).

---

## Post-deploy checks

Work down this list; each step depends on the ones above it.

1. **Sign in.** A magic link should land on `/series`, not an error page. If it
   fails, the Supabase redirect allowlist is wrong.
2. **Create a series and generate a bible.** Exercises Anthropic, the SSE route
   and the 300s ceiling. Text should appear within a second or two — reasoning
   is streamed as a separate channel.
3. **Check Inngest.** The dashboard should list five functions. If it lists
   none, the sync has not run.
4. **Generate one shot.** Exercises Replicate, the durable job, the spend guard
   and `ingestFromUrl`. Watch for a `402` (no credit) or a `422` (the model
   rejected an input it does not declare).
5. **Preview a voice.** Exercises ElevenLabs.
6. **Render an episode.** Exercises Shotstack and the 50MB bucket ceiling.
7. **Check `/usage`.** Real charges should be recorded against the right
   operations.

## Rolling back

`vercel rollback` returns to the previous deployment. Note what it does *not*
undo:

- **Database migrations.** Forward-only; a rollback leaves the new schema.
- **In-flight Inngest runs.** They continue against whatever is now deployed.
  Pause the app in the Inngest dashboard first if a bad deploy is actively
  spending money.
- **Money already spent.** Provider charges are not reversible. The per-user
  ceiling (`MAX_MONTHLY_SPEND_CENTS`) is the only real brake, so set it
  deliberately before opening the app to anyone else.
