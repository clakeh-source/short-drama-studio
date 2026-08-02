# Short Drama Studio

Turn a one-line premise into a finished vertical (9:16) short-drama episode:
series bible → episode script → storyboard → per-shot video prompts → generated
clips, voiceover and captions → assembled MP4.

**The human reviews and edits at every stage boundary.** Nothing auto-advances
from script to spend. Every generate action is explicit and shows an estimated
cost first.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, auth, schema, RLS, provider boundary | **complete** |
| 1 | Series bible + episode scripting | **complete** |
| 2 | Storyboard and shot prompts | **complete** |
| 3 | Asset generation | **complete** — all criteria verified at runtime, including a kill/restart mid-generation |
| 4 | Assembly and export | **complete** — caption burn-in verified on a real render (needs a libass ffmpeg, see below) |
| 5 | Library, continuity, polish | **complete** |
| 6 | Real video and voice providers | **complete** |
| 7 | Live provider verification | **voice verified; video blocked** — the Replicate account has no credit |
| 8 | Production deployment | **prepared, not deployed** — see [docs/DEPLOY.md](docs/DEPLOY.md) |

Every acceptance criterion across the first six phases has been verified. The two
that needed real infrastructure rather than a unit test are written up below:
Phase 3 AC #2 (restart mid-generation without double-charging) under *Durable
jobs*, and Phase 4 AC #3 (caption burn-in) under *Assembly*.

Phase 7 took the Phase 6 adapters off mocks and pointed them at real accounts.
ElevenLabs passed end to end. Replicate could not be run at all — the token
authenticates but the account has no credit, so every prediction is refused with
HTTP 402. Both outcomes are written up under *Live verification*; the second one
is a purchase, not a code change.

Phase 8 made the app deployable: every long-running route now declares a
`maxDuration` (Vercel kills a function at 15s by default, and a script
generation runs minutes), functions are pinned to the Supabase region, and the
local ffmpeg renderer refuses to load on Vercel instead of failing after an
episode has already paid for its clips. Nothing has been deployed — that needs a
Vercel account and three purchases. [docs/DEPLOY.md](docs/DEPLOY.md) is the
runbook.

---

## Finish the setup

Phase 0 provisioned the Supabase project **short-drama-studio**
(`ngdylofqpndlpkwpzgas`, eu-west-3) and applied the full schema, indexes and RLS
policies to it. Two secrets cannot be read through the management API, so they
have to be pasted into `.env.local` by hand:

```bash
nvm use            # reads .nvmrc — Node 24; pnpm 11 needs >= 22.13
pnpm install && pnpm db:migrate && pnpm db:buckets && pnpm dev
```

> **Watch your Node version.** `pnpm` 11 refuses to run on Node < 22.13, and
> Homebrew installs its own `node` as a transitive dependency of other formulae,
> which can quietly shadow whatever `nvm` had selected. If `pnpm` starts
> complaining about the Node version, `nvm use` in the project root fixes it.

`pnpm db:migrate` applies the versioned SQL in `/drizzle`; `pnpm db:buckets`
creates the four private Storage buckets (`clips`, `audio`, `renders`,
`references`). Background jobs need a second terminal:

```bash
pnpm inngest:dev
```

`pnpm db:seed` puts one complete series in the database — *The Last Ferry*, two
characters, one episode, two scenes, four shots — so a fresh clone has something
to click through and later phases have fixed data to test against. It is
idempotent: each run drops the seed series and rebuilds it, and touches nothing
else. The raw screenplay it was built from stays in `scripts/seed/episode-1.txt`.

`GET /api/health` reports the database and the job queue, unauthenticated, and
answers 503 when either is down.

Deploying instead of running locally? [docs/DEPLOY.md](docs/DEPLOY.md).

### Use `db:migrate`, not `db:push`

**`drizzle-kit push` crashes against a Supabase database.** Its check-constraint
introspection ignores `schemaFilter`, so it pulls the 43 check constraints in
Supabase's `auth` schema and then throws on one it cannot parse:

```
TypeError: Cannot read properties of undefined (reading 'replace')
    at .../drizzle-kit/bin.cjs:17861
```

This is drizzle-kit 0.31.10, the current stable; only 1.0.0 release candidates
are newer. `drizzle-kit migrate` applies the generated SQL without introspecting
the database at all, so it is unaffected — and versioned migrations are the right
thing for a deployed database regardless.

---

## How a series gets made

1. **Premise → series.** `/series/new` takes one line plus genre, tone, audience,
   language and episode targets. The content-safety gate runs here, before the
   row exists and before a token is spent.
2. **Series bible.** One Anthropic call returns title, logline, world, tone rules,
   3–6 characters (each with an `appearance_prompt`), the season arc and a
   one-line synopsis per episode. Streamed to the screen as it is written.
3. **Review and edit.** Everything in the bible is editable. Character edits are
   the load-bearing ones — an `appearance_prompt` is copied verbatim into every
   shot prompt that character appears in, so it is what keeps them looking like
   the same person across shots.
4. **Episode script.** Scenes, and inside each scene ordered beats — an action
   plus at most one line of dialogue. A beat maps one-to-one onto a shot in
   Phase 2.
5. **Per-scene rewrite.** Regenerating scene 3 replaces scene 3 and nothing else;
   every other scene object is carried across unchanged.
6. **Storyboard.** Each scene becomes ordered shots — camera, action, who is in
   frame, duration. Every shot gets a video prompt composed deterministically
   (see below), editable, splittable, mergeable and drag-reorderable.
7. **Cost, before spend.** The estimate panel prices the whole board through the
   same provider calls generation will make. Nothing is generated until asked.
8. **Generate.** A confirmation dialog states the cost, then each shot becomes a
   durable Inngest job: submit → poll on a backoff → download → store → record
   the real cost. Three video jobs run per user at a time; the rest queue.
9. **Fix what came back wrong.** Per-shot retry, and a one-click fix when a
   voiceover runs longer than its clip.
10. **Assemble.** Clips, voice tracks and caption cues are laid onto one timeline
    and rendered to a single 1080x1920 MP4. Preview it in a 9:16 player with a
    shot-boundary scrubber, then download.
11. **Post it.** A caption and hashtag block written from the episode's own
    synopsis and cliffhanger, plus the AI-generated disclosure.

Duration is budgeted, not hoped for: dialogue at 2.5 words/second, 2s per silent
action beat, 0.5s of staging around a spoken line. `lib/timing.ts` is the single
definition, shared by the prompt, the UI badge and the tests.

## Architecture

### The provider boundary

Every external service sits behind an interface in `lib/providers/types.ts`
(`LlmProvider`, `VideoProvider`, `TtsProvider`, `RenderProvider`). **No provider SDK is
imported anywhere outside `/lib/providers`** — this is the load-bearing
constraint of the build, and it is enforced by a `no-restricted-imports` rule in
`eslint.config.mjs` rather than left to discipline.

Selection is by env var (`LLM_PROVIDER`, `VIDEO_PROVIDER`, `TTS_PROVIDER`,
`RENDER_PROVIDER`)
through the registry in `lib/providers/registry.ts`. Adding a provider is one
adapter file plus one line in the registry — zero changes elsewhere.

The `stub` adapters are the default. They return fake data after a 2s delay,
cost nothing, and mimic real provider behaviour: async job handles, a `pending`
→ `ready` polling lifecycle, and injectable failures. Putting `[[stub:fail]]` in
a prompt produces a retryable failure; `[[stub:fail-permanent]]` a terminal one.
The stub LLM returns schema-valid fixtures sized to the same duration budget, so
the whole Phase 1 pipeline runs in CI with no key and no spend.

### Real providers

Five adapters exist alongside the stubs:

| Slot | Adapters | Env var |
|---|---|---|
| llm | `anthropic` | `LLM_PROVIDER` |
| video | `replicate` | `VIDEO_PROVIDER` |
| tts | `elevenlabs` | `TTS_PROVIDER` |
| render | `shotstack`, `ffmpeg` | `RENDER_PROVIDER` |

Every adapter reads its credentials **inside its methods, not its constructor**.
Resolving a provider is therefore free, which is what lets `pnpm build` and the
registry tests run without a Replicate token or an ElevenLabs key.

None of them use a vendor SDK except Anthropic's. Replicate, ElevenLabs and
Shotstack are plain REST over `fetch` — a few dozen lines each, no dependency, no
lockfile churn, and nothing new for the `no-restricted-imports` rule to police.

#### Replicate hosts the model; it does not define it

`REPLICATE_VIDEO_MODEL` picks which video model runs, and the things the app
needs to know — what clip lengths it accepts, what it costs, what it calls its
inputs — are properties of *that model*, not of Replicate. So they are
configuration rather than constants:

| Var | Why it exists | Default |
|---|---|---|
| `REPLICATE_VIDEO_DURATIONS` | `clampDuration` is the storyboard's duration grid. Get it wrong and shots come out the wrong length. | `5,10` |
| `REPLICATE_VIDEO_COST_CENTS_PER_SECOND` | Drives the pre-flight estimate *and* the recorded charge. | `5` |
| `REPLICATE_VIDEO_IMAGE_INPUT` | Reference images go in `image`, `start_image` or `first_frame_image` depending on the model. | `image` |
| `REPLICATE_VIDEO_EXTRA_INPUT` | A JSON object of model-specific knobs, merged *beneath* the canonical fields so a typo cannot displace the prompt. | `{}` |

A bare `owner/name` slug posts to that model's own predictions endpoint and runs
whatever version is current; `owner/name:version` posts to `/v1/predictions` with
the version pinned. Prefer the pinned form — a model updated underneath you
changes what the episode looks like.

Two things are worth knowing about the money. Replicate does not report what a
prediction cost, so the charge is computed from the per-second price above; it is
exact only when that number matches the model's published rate. And it is priced
from the duration echoed back in the prediction's own `input`, not from what the
shot asked for — those differ whenever the grid clamped the request, and the
model bills for what it actually rendered.

#### ElevenLabs, and the alignment nobody was returning

The TTS adapter calls `/with-timestamps` rather than plain synthesis. It costs
the same and returns per-character alignment alongside the audio.

`TtsWordTiming` had been on the provider interface since Phase 0, and
`lib/timeline.ts` already preferred real alignment over its length-proportional
approximation — but no provider had ever filled it in, so the fallback was the
only path that had ever run. Two lines in `generate-shot-voice.ts` now persist
the timings into the voice asset's `meta`, where `lib/data/render.ts` was already
looking for them. Captions land on the word actually being spoken.

Output is `wav_24000`, not the API's default MP3, for two reasons: the voice
upload is stored as `audio/wav` and that content type has to stay honest, and the
duration is read off the alignment rather than parsed out of frame headers. 24kHz
specifically because the 44.1kHz WAV and PCM formats need an ElevenLabs Pro plan
and a phone-screen drama does not need them.

Pricing is per character and the value of a credit depends on the plan, so
`ELEVENLABS_CENTS_PER_1K_CHARS` defaults to the Creator rate rounded up (`3`) and
is meant to be set.

Voice tags come from the **values** of ElevenLabs' labels, not the keys —
`assignDefaultVoices` in `lib/voices.ts` matches on words like "warm", "young"
and "narration", which is what lives in the values of `age`, `description` and
`use_case`. Underscored values are split, so `middle_aged` is matchable as
`middle` and `aged`.

### Live verification

`tests/live-providers.test.ts` runs the adapters against the real services. Each
half is gated separately, because voice costs cents and video does not:

```bash
RUN_LIVE_TTS=1   pnpm test tests/live-providers.test.ts
RUN_LIVE_VIDEO=1 pnpm test tests/live-providers.test.ts
```

The mocked suites pin what an adapter *sends* and how it reads a response we
wrote ourselves. Only a live call proves the field names are right, the auth
header is the one the service wants, and the response really has the shape the
code destructures.

**ElevenLabs passed on the first run.** 35 voices in the catalogue, a two-hander
cast onto two distinct voices, and `"You told me he was dead."` came back as an
80 KB `RIFF`/`WAVE` buffer measuring 1.672 s, with alignment that reassembles the
line exactly:

```
You 0→0.267  told 0.325→0.499  me 0.546→0.615
he 0.662→0.72  was 0.766→0.871  dead. 0.917→1.672
```

**Replicate could not be run.** The token authenticates — `/v1/account` returns
the right user — but the account has no credit, so `POST /predictions` returns
402 `Insufficient credit` before the model is ever reached. Buy credit and run
the gated suite above; nothing in the code changes.

#### Two things the live run found

**A refusal at submit time was being retried.** `ProviderResult` has always
carried `retryable` for work that was accepted and then failed, but *submission*
had no equivalent — an adapter could only throw, and a throw inside an Inngest
step is retried by policy. So the 402 above would have burned all four attempts,
each one guaranteed to fail identically, before the shot failed with an opaque
message. Adapters now throw `ProviderRequestError` carrying a verdict
(`isRetryableStatus`: 5xx, 429 and 408 pass, the rest of 4xx does not), and both
jobs read it — the video job converts a permanent refusal into a
`NonRetriableError` after recording the reason on the asset, and the voice job
no longer hardcodes every failure as transient. A mocked test could not have
found this, because the mock only ever returned the statuses we thought to write.

**Model input schemas vary more than the adapter's canonical fields assume.**
Replicate exposes each model's input schema for free
(`GET /v1/models/{owner}/{name}`), and across five candidates almost nothing is
universal:

| Model | `aspect_ratio` | `negative_prompt` | `seed` | reference image | default duration |
|---|---|---|---|---|---|
| `bytedance/seedance-1-lite` | yes | **no** | yes | `image` | 5 (4–12) |
| `google/veo-3-fast` | yes | yes | yes | `image` | 8 |
| `kwaivgi/kling-v2.1` | **no** | yes | **no** | `start_image` *(required)* | 5 |
| `minimax/hailuo-02` | **no** | **no** | **no** | `first_frame_image` | 6 |
| `wan-video/wan-2.5-t2v` | **no** (`size`) | yes | yes | — | 5 |

`kling-v2.1` requires `start_image`, which makes it image-to-video and unusable
for a text-prompt pipeline. Of the rest, `google/veo-3-fast` is the only one
whose inputs match the adapter's canonical set exactly. This is what
`REPLICATE_VIDEO_EXTRA_INPUT` and `REPLICATE_VIDEO_IMAGE_INPUT` are for, but they
only add fields — they cannot remove one the model does not declare. Whether
Replicate rejects an undeclared input or ignores it is **still unknown**: the 402
fires before input validation, so the probe that would have settled it never got
that far. Until it is settled, **generate one shot before generating a board.**

#### An observation, not yet a change

`lib/timing.ts` budgets dialogue at 2.5 words/second. The six-word line above
took ElevenLabs 1.672 s — about 3.6 words/second. If that holds across voices and
lines, scripts written to a 60 s target will come in short, because the budget
assumes slower speech than the synthesiser delivers.

One line on one voice is not enough to move a constant that drives script
generation and four Phase 1 acceptance tests. Measure a spread of voices and
lines first.

### Streaming, and why reasoning is a separate channel

`LlmProvider.stream()` yields `{ type: 'thinking' | 'text' }`. With adaptive
thinking on, `claude-sonnet-4-6` reasons for **up to two minutes** before the
first character of the answer. Carrying only `text` left the screen blank for
that whole window; carrying reasoning too puts something on screen in about a
second. Only `text` is accumulated into the JSON.

### JSON without structured outputs

`claude-sonnet-4-6` does not support `output_config.format`, so the schema is
enforced client-side: ask for JSON, extract it (tolerating fences and prose),
validate with Zod, and on failure re-ask once with the validation errors
appended. Usage is summed across attempts — a retry is never billed as free.

### Model output is intent, not answer

Every numeric target in the spec failed on the first live run because the model
treats numbers as suggestions. Each is now enforced in code, with tests:

| The model decides | The code guarantees |
|---|---|
| How long each shot should be | `fitShotDurations` snaps to the provider's duration grid and nudges to the episode budget |
| How many shots to cut | `fitShotCount` merges an over-covered board down, splits an under-covered one up, never empties a scene |
| How long the script runs | `streamJson`'s `validate` hook measures the script and re-asks with the real numbers — "that runs 45s, it needs 60s, add ~4 beats" |
| Coverage, framing, who is in frame | unchanged — this is the part a model is actually good at |

The script prompt also states scene and beat counts rather than a duration,
because "exactly 3 scenes, 5-7 beats each" is followable and "about 60 seconds"
is not. `lib/timing.ts` derives those from the target; `lib/shots.ts` holds the
shot-level fitting, provider-grid-aware by injection.

### Latency: `effort` is the whole ballgame

Measured on a series bible, same prompt, same model:

| Setting | Wall clock | Output tokens | Valid first try |
|---|---|---|---|
| `effort: medium`, 24k budget | **~16 min** | — | timed out |
| `effort: low`, adaptive thinking | **38s** | 1587 | yes |
| `effort: low`, thinking off | **38s** | 1520 | yes |

Adaptive thinking expands to fill whatever `max_tokens` allows, and `max_tokens`
has to cover thinking *plus* the answer. At `medium` that produced 16-minute
script generations — unusable regardless of correctness. At `low` the same task
takes 38 seconds with no measurable quality loss, so `low` is the default
everywhere, with thinking left on because it costs nothing and feeds the
progress UI. The adapter now raises a named error when a response is truncated by
its budget instead of failing later as "no JSON found".

### Why prompts are concatenated, not generated

`lib/ai/prompts.ts` is a **pure function, not an LLM call**. Character
consistency across shots depends on the *same* appearance text appearing
verbatim in every prompt the character is in, and a model asked to "describe her
again" paraphrases — so the face drifts. Fixed order:

```
camera → appearance_prompt(s) verbatim → action → location/time-of-day → style suffix
```

A human's `prompt_override` wins outright and survives storyboard regeneration
(keyed by scene and shot position, since a regenerated board is new rows).

### Durable jobs

Each shot is one Inngest function, and every external interaction is its own
`step.run`. Inngest records step results durably, so killing the dev server
mid-generation and restarting resumes from the last completed step — the provider
is never called twice for the same attempt, so nothing is double-charged.

| Concern | How |
|---|---|
| Concurrency | Two layers — see below. Measured at a peak of 3 in-flight provider jobs across a 20-shot episode |
| Polling | 5s, 10s, 20s, then 30s to a 15-minute ceiling (`lib/inngest/backoff.ts`) |
| Retries | Two policies, deliberately separate — see below |
| Idempotency | The Inngest event id encodes shot + attempt, so a double-click dedupes and a real retry does not |
| Spend cap | Checked once for the whole episode before any event is sent, so going over queues *nothing* |
| Storage | Private buckets, signed URLs only; paths include the attempt so a retry never races the previous upload |

#### Why retries need two policies

Two different things can go wrong, and only one of them is the provider's fault:

| Failure | Owned by | Policy |
|---|---|---|
| The provider reports a clip as failed | this app's loop | `shouldRetry(retryable, attempt)` — at most two, never for a non-retryable failure |
| A crash, a deploy, a dropped connection | Inngest | `retries: 3` on the shot functions |

Provider failures are **caught and returned** (`{ ok: false, retryable }`), never
thrown, so raising Inngest's `retries` cannot multiply them — the two policies do
not overlap.

This was originally `retries: 0`, reasoning that the app owned retries. That
silently removed all durability: the first infrastructure throw killed the run
outright. Restarting the dev server mid-generation stranded the episode at 10 of
20 shots, with Inngest never re-invoking the functions again.

Because Inngest may now re-run a step that never completed, `submit` first checks
for a provider job id already recorded on the asset and adopts it rather than
buying a second clip.

#### Why concurrency needs two layers

`concurrency: { limit: 3, key: 'event.data.userId' }` bounds *step execution*, not
provider work: the poll loop hands its slot back on every `step.sleep`. Reading
the config alone is therefore misleading, and the first full run through the UI
proved it — a 20-shot episode submitted **all 20** clips to the provider before
the first one finished.

The bound that actually holds is `claimVideoSlot` in `lib/data/generation.ts`,
which counts in-flight work where it really lives (video assets sitting at
`generating`) under a per-user advisory lock, and waits before `submit` so a
queued shot costs nothing while it waits. Slots carry a
`VIDEO_SLOT_LEASE_MINUTES` lease, so a worker that dies mid-job cannot wedge the
account.

To measure it on a real run, count overlapping submit/complete pairs in the
structured logs:

```bash
grep -ao '{"level".*' dev.log | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const ev=[];for(const l of s.split("\n")){let j;try{j=JSON.parse(l)}catch{continue}if(!j.shotId)continue;if(j.operation==="video.submit")ev.push({t:j.ts,shot:j.shotId,k:1});if(j.operation==="video.ready"||j.operation==="video.failed")ev.push({t:j.ts,shot:j.shotId,k:-1})}ev.sort((a,b)=>a.t<b.t?-1:1);const open=new Set();let peak=0;for(const e of ev){e.k===1?open.add(e.shot):open.delete(e.shot);peak=Math.max(peak,open.size)}console.log("peak concurrent provider jobs:",peak)})'
```

Voice duration is stored **as measured**, never trimmed to fit. A line longer
than its shot is a real problem the editor has to decide about, so it surfaces as
a warning with a one-click "extend the shot" fix.

### Assembly

`lib/timeline.ts` is the single definition of where everything sits. Positions
come from one cumulative sum over the shot *slot* lengths, never from a clip's
own metadata — a provider returning a 5.04s file for a 5s slot must not shift
everything after it. That is why voiceover drift is exactly zero rather than
merely under the 100ms the spec allows.

Captions are burned in. `lib/captions.ts` owns the presets, generates the ASS the
ffmpeg adapter renders, and refuses a style whose text could land inside the
bottom 12% or top 10% where platforms draw their own interface. Word timings come
from the TTS provider when it reports them, and otherwise from distributing the
measured clip duration across the words by length.

Two render adapters sit behind `RenderProvider`, chosen by `RENDER_PROVIDER`:

| Adapter | What it is |
|---|---|
| `shotstack` | The cloud default. Posts a JSON edit, polls for the hosted output. |
| `ffmpeg` | The local fallback. `libx264 -crf 20 -preset medium`, AAC, `loudnorm=I=-14`, subtitles burned via the `subtitles` filter. |
| `stub` | Free and instant, for CI. |

The ffmpeg adapter does the encode in-process: `render()` awaits it and `poll()`
then reports the file. It has no durable server-side job, so a crash mid-encode
loses that render and it has to be restarted — the trade for having no external
dependency, and why the cloud adapter is the default.

#### The ffmpeg adapter needs libass to burn captions

The `subtitles` filter requires libass, and **Homebrew's core ffmpeg bottle ships
without it** — no libass, no freetype, so neither `subtitles` nor `drawtext`
exists:

```
$ ffmpeg -filters | grep subtitles      # nothing
$ ffmpeg -version | grep libass         # nothing
```

The adapter probes for the filter and fails with an actionable message rather
than a filtergraph error.

To get burn-in locally you need the `homebrew-ffmpeg` tap, where libass is a
*required* dependency. Note two traps: there is **no `--with-libass` flag** (it is
not optional there, so passing it is an error), and the two formulae are both
named `ffmpeg`, so they cannot coexist — brew makes you uninstall first:

```bash
brew tap homebrew-ffmpeg/ffmpeg
brew uninstall ffmpeg                              # required; they conflict
brew install homebrew-ffmpeg/ffmpeg/ffmpeg         # builds from source, 30+ min
```

In practice the dependencies pour as bottles and only ffmpeg itself compiles, so
it took a few minutes rather than thirty. `brew uninstall ffmpeg` also triggers an
autoremove of formulae that were only there as its dependencies — here that took
`go`, `node@24` and `python@3.13` with it, so check `brew leaves` afterwards if you
rely on any of those. (An nvm-managed Node is unaffected; only Homebrew's copy
goes.) `RENDER_PROVIDER=shotstack` remains the alternative, rendering captions
server-side.

Once libass is present, `tests/ffmpeg-encode.test.ts` un-skips two burn-in tests
automatically and both pass. **Verified end to end**: a real 20-clip, 19-caption
episode rendered through `RENDER_PROVIDER=ffmpeg` to 1080x1920 H.264 + AAC, 30fps,
60.0s, with the caption text visible in the frame and no separate subtitle stream.

#### Burn-in is verified on the pixels, not just the exit code

"The render succeeded and holds no subtitle stream" is equally true of a render
where the `subtitles` filter ran and drew nothing, so the second test renders the
same timeline twice — with captions and without — and compares mean luminance in
the band where captions are drawn against an unaffected control band at the top of
the frame:

| Band | Without captions | With captions | Delta |
|---|---|---|---|
| Caption area (60-88% of height) | 104.51 | 106.30 | **1.79** |
| Control (10-35% of height) | 125.49 | 125.49 | 0.00 |

The control band is byte-identical, so the difference is the captions and nothing
else. The threshold is a delta above 1 with the caption band moving at least twice
as much as the control; the measured margin on the current style is not enormous
(1.79 against 1.0), so a much thinner future caption style may need the crop
tightened onto the text line.

#### A `file://` trap the libass guard was hiding

The local adapter returns a `file://` URL, and Node's `fetch` refuses that scheme
outright (`TypeError: fetch failed`, cause "not implemented... yet..."). So
`RENDER_PROVIDER=ffmpeg` could finish a whole encode and then fail to store it.
Nobody had seen it because the missing-libass check failed those renders before
they ever reached the ingest step. `downloadToBuffer` now reads `file://` from
disk — via `fileURLToPath`, not `slice(7)`, so a path containing spaces still
works — and `tests/storage-download.test.ts` covers it.

Everything else about the encode — 1080x1920, 30fps, H.264 + AAC, -14 LUFS — works
on a stock build and is verified by `tests/ffmpeg-encode.test.ts`.

### Data isolation

Every row is reachable from exactly one `series.user_id`, and each table carries
one Postgres RLS policy scoped to the `authenticated` role. Application queries
deliberately carry **no** `where user_id = ...` clause: they run inside
`withUserDb(userId, …)` (`lib/db/index.ts`), which opens a transaction, assumes
the `authenticated` role and binds `auth.uid()`, so the database is what enforces
the boundary. `db()` is the privileged handle that bypasses RLS and is reserved
for background jobs.

### Secrets

No provider key ever reaches a client bundle, and none is committed.
`pnpm check:secrets` runs as part of `pnpm build` and fails it on any of three
things: a `NEXT_PUBLIC_` variable whose name looks like a secret; a client
component or unauthorised module reading one; or **a secret with an actual value
in `.env.example`**.

That last check is there because the first two did not catch what actually
happened. `.gitignore` covers `.env`, `.env.local` and `.env*.local` — but not
`.env.example`, which is the one env file git tracks. It had quietly accumulated
live Anthropic, ElevenLabs, Replicate, Inngest and Supabase service-role
credentials. The rule is emptiness rather than "does this look like a real key",
because emptiness is something a build can actually enforce; `.env.local` is
expected to be full of real values and is deliberately not examined.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server |
| `pnpm build` | Secret check + production build (typecheck + lint included) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint, including the provider-boundary rule |
| `pnpm test` | Vitest — free suites always; RLS needs `DATABASE_URL`, live-model needs `RUN_LIVE_LLM=1` |
| `RUN_LIVE_LLM=1 pnpm test tests/live-anthropic.test.ts` | The Phase 1 criteria against the real model. **Spends money.** |
| `RUN_LIVE_TTS=1 pnpm test tests/live-providers.test.ts` | The ElevenLabs adapter against the real API. **Spends money** (cents). |
| `RUN_LIVE_VIDEO=1 pnpm test tests/live-providers.test.ts` | The Replicate adapter against the real API. **Spends money.** Needs credit on the account. |
| `brew install ffmpeg` | Needed for the local render adapter and the encode/assembly tests |
| `pnpm db:generate` | Generate SQL migration from `lib/db/schema.ts` |
| `pnpm db:migrate` | Apply the versioned migrations in `/drizzle` (**use this**) |
| `pnpm db:push` | Diff-based apply — **broken against Supabase**, see above |
| `pnpm db:buckets` | Create the private Storage buckets (idempotent) |
| `pnpm db:seed` | Seed one full series → episode → scenes → shots → characters (idempotent) |
| `pnpm orphans` | Report storage objects no row points at (`--delete` to remove them) |
| `pnpm inngest:dev` | Inngest dev server against `/api/inngest` |
| `pnpm check:secrets` | Standalone secret-exposure scan |
| `pnpm test:e2e` | Playwright — the whole journey against stub providers |
| `node scripts/lighthouse.mjs <url>` | Lighthouse performance against a **production** build |

> **Do not run `pnpm build` while `pnpm dev` is running.** They share `.next`, and
> the build overwrites what the dev server has loaded — the dev server then
> answers every request with `Cannot read properties of undefined (reading
> '/_app')`. Stop the dev server first, or `rm -rf .next` to recover.

### Performance, measured

`scripts/lighthouse.mjs` runs against a production build, signing itself in with
a minted magic link. Measuring `next dev` would be meaningless: unminified
bundles, an HMR client and no compression score badly no matter how good the page
is.

The storyboard route scores **100** on Lighthouse's desktop preset, and **99** on
the mobile preset:

| Metric | Desktop | Mobile (4G, 4x CPU) |
|---|---|---|
| First Contentful Paint | 0.2 s | 0.9 s |
| Largest Contentful Paint | 0.5 s | 2.1 s |
| Total Blocking Time | 0 ms | 10 ms |
| Cumulative Layout Shift | 0 | 0 |

Getting there took three changes to the request path and one to the measurement.

**The measurement was wrong first.** The script set `formFactor: 'desktop'` but
left throttling at the default, so Lighthouse scored a desktop page against the
desktop curve while simulating a 1.6 Mbps mobile connection and a 4x CPU
slowdown. That is not a stricter test, it is an inconsistent one — this route
ships ~230 KB of HTML, which cannot arrive quickly at 1.6 Mbps however fast the
server is. It now uses Lighthouse's own `desktop-config`.

The three real fixes, in order of what they were worth:

1. **The spend meter blocked the whole app.** The layout awaited
   `getSpendSummary` — a `withUserDb` transaction measured at 190-490 ms — before
   rendering anything, so every route paid for a header widget before its own
   content could start. It streams now (`components/shell/spend-meter.tsx`).
2. **`getUser` ran twice per render.** The layout and the page each called it, at
   100-215 ms a time, because each one verifies the token with the auth server.
   `lib/auth.ts` wraps it in React's `cache`, so it runs once per request. This
   weakens nothing: it is still a real verification, just not repeated against
   itself.
3. **The storyboard page ran two transactions** and loaded the cast twice.
   `loadStoryboardPage` does it in one, and the page streams the board behind the
   shell.

Time to first byte on the storyboard route went from ~550 ms to ~115 ms.

### The shot list renders only what is near the viewport

A shot card is ~8.7 KB of markup — more than half of it repeated Tailwind class
attributes, plus seven inline SVG icons each — and only four fit on screen. A
twenty-shot board shipped ~170 KB of cards nobody was looking at, and a
five-minute episode can hold a hundred. Cards below the fold now ship as
reserved-height placeholders and mount as they approach the viewport
(`components/storyboard/deferred-shot.tsx`).

| | Before | After |
|---|---|---|
| Storyboard HTML (production) | 231 KB | **100 KB** |
| Inline SVG icons | 140 | 51 |
| `class` attribute bytes | 97 KB | 35 KB |

**It is mount-once, not a sliding window.** A conventional virtual list unmounts
rows as they leave the viewport, which would break drag-to-reorder: you cannot
drop a shot onto a row that does not exist, and this board lets you drag shot 1
to the far end of the episode. Keeping a card mounted after its first appearance
costs nothing on load — the win is entirely in what is *not* sent initially — and
leaves reordering, `j`/`k`, in-page find and each card's expanded state alone.
Placeholders keep their `data-shot-id` and drop handlers, so they are valid drop
targets and `scrollIntoView` can still find them.

The reserved height (234 px) is measured, not estimated, so CLS stays at 0; the
e2e asserts that mounting a card does not change the page height.

### The board sends only what the client reads

Virtualising the markup left the RSC payload untouched: props for *every* shot
cross the wire whether or not the card renders, because the client needs the full
list to order, size and later mount it. Three fields were riding along unread —
see the note on `BoardShot` in `components/storyboard/types.ts`:

| Field | Why it was dead | Size (20 shots) |
|---|---|---|
| `videoPrompt` | The card recomposes the prompt live from the current edits with the same pure function the server persists with. Sending the stored copy also risked showing a stale prompt beside an unsaved edit. | 6.7 KB |
| `negativePrompt` | Series-level, not per-shot — the table held exactly **one** distinct value across all twenty rows. Now passed once on the workspace. | 4.0 KB (3.8 KB of it duplication) |
| `sceneId` | Only ever written, never read. Which scene a shot is in is the tree's shape. | ~0.7 KB |

`BoardScene.summary` went too; the script editor has its own type and the
storyboard never displayed it.

### Page render times

Measured against a production build, fully rendered (not first byte — Next flushes
a shell early, so TTFB flatters every one of these):

| Route | Before | After |
|---|---|---|
| `/generate` | 1500 ms | **999 ms** |
| `/export` | 977 ms | 910 ms |
| `/storyboard` | 582 ms | 598 ms |
| `/library` | — | 379 ms |
| `/api/…/status` (polled every 3 s) | — | 547 ms |

`/generate` was the worst page in the app and the one where the user commits money.
It made four sequential `withUserDb` calls — episode, board, spend, progress — and
one `withUserDb` costs ~139 ms against a database in another region, measured:

| | Median |
|---|---|
| One bare query | 28 ms |
| Transaction + one query | 82 ms |
| Transaction + 2 `set_config` + query (= `withUserDb`) | **139 ms** |
| Two of those, sequentially | 274 ms |

So: reuse `loadStoryboardPage` for the first two, overlap the spend and progress
reads (the month's spend total does not depend on this episode), and batch the
signed URLs. `/export`'s two calls are genuinely dependent, which is why it barely
moved.

`buildEpisodeStatus` now builds the board shape once for both the server page and
the `/status` poll. They each assembled it by hand before — the same duplication
that left `buildRendersPayload` missing a field on one side — and both
reimplemented the voice-overrun comparison inline instead of calling
`voiceOverruns`, which moved to `lib/shots.ts` so the data layer can use it without
importing an Inngest function (that would be a cycle).

### What none of this fixed: LCP

LCP sat at ~2.2-2.3 s on the mobile profile before and after both changes, because
the largest element is in the first viewport and those cards were always rendered.
Trimming what is below the fold cannot move it, and neither can shrinking data the
first screenful does not use. Total transfer fell 57% (231 KB to 100 KB) and Speed
Index improved, but anyone expecting page weight to be the LCP bottleneck — as an
earlier version of this README implied — would be wrong. On the mobile profile the
remaining LCP cost is the ~365 ms auth round trip plus hydration, not bytes.

---

## Deviations from the spec

1. **`series.user_id` has no foreign key to `auth.users`.** A cross-schema FK
   makes `drizzle-kit push` want to manage the `auth` schema, which risks Phase 0
   AC #2 ("applies cleanly to a fresh database"). Ownership is enforced by the
   RLS policies instead. Cleanup on user deletion is a Phase 5 concern; add it as
   a hand-written migration if wanted.

2. **Inngest events are typed with `EventSchemas.fromRecord`, not `fromZod`.**
   Inngest's Zod bridge is typed against Zod 3 and this project is on Zod 4.
   Inputs that cross a trust boundary are still Zod-validated at the route
   handler, which is where validation belongs; events are emitted by our own
   server.

3. **`shots.prompt_override` was added to the schema early.** Phase 2 AC #6
   requires a manually overridden prompt to survive storyboard regeneration,
   which needs a column distinct from `video_prompt`. Adding it now avoids a
   migration later.

4. **`components/ui/button.tsx` is a client component.**
   `@radix-ui/react-slot` calls `React.createContext` and ships no `use client`
   directive, which breaks the RSC build.

5. **The RLS Vitest suite skips when `DATABASE_URL` is unset** rather than
   failing, so `pnpm test` is green on a fresh clone. It does not pass vacuously
   — it announces the skip.

6. **`effort` is `medium` for the bible and script, `low` for a single scene.**
   The spec does not set it. At `high`, a bible took ~195s end to end, most of it
   thinking, for no visible quality gain on this task.

7. **AC #6 is met for the UI, not on a literal reading.** The criterion asks for
   a first token within 500ms. The route emits an SSE `status` frame before it
   calls the model, so the screen populates in single-digit milliseconds — the UI
   never blocks. The model's own first token arrives in 1.2-3.5s, which is
   network round-trip plus remote time-to-first-token and is not something an
   app-side change can push under 500ms. Before the thinking channel existed it
   was ~125s; that was the real defect, and it is fixed.

8. **Phase 2 shot counts and durations are enforced, not requested.** The spec
   states them as acceptance criteria; the model treats them as suggestions. See
   "Model output is intent" above.

9. **Prompt overrides survive regeneration by position**, not by row id — a
   regenerated board is a different set of rows, so position is the only
   identity available. If a regeneration changes a scene's shot count, later
   overrides in that scene land on a neighbouring shot. Overridden shots are
   badged in the UI for exactly that reason.

10. **Schema field limits are generous, and the prompt carries the real budget.**
    The first live run failed every bible because episode synopses ran past a
    600-character cap and the retry could not reliably shorten them. Limits are
    now ceilings that catch runaway output; the target lengths live in the prompt
    where the model can act on them.

11. **An `LlmProvider` interface was added**, which the spec's interface list
    does not include. The spec also says no provider SDK may be imported outside
    `/lib/providers`, and `@anthropic-ai/sdk` is a provider SDK. Putting it
    behind an interface satisfies both, and is what lets the stub run the
    pipeline in CI. `VideoProvider` also gained `clampDuration`, so the
    storyboard can plan against the real duration grid.

12. **Storage buckets cap at 50MB**, the Supabase free-tier global upload limit;
    asking for more is rejected outright. Override with `SUPABASE_FILE_SIZE_LIMIT`
    on a paid plan — a 60-second 1080x1920 render can approach it.

13. **Voice failures are treated as retryable.** The TTS interface has no
    retryable flag (it throws rather than returning a `ProviderResult`), and TTS
    failures are overwhelmingly transient, so they go through the same
    two-retry ceiling as video.

14. **The per-shot content check is rules-only.** The cross-cutting requirement
    says to screen before every generation call; running the model classifier per
    shot would add cost and latency to every clip, and the premise and bible were
    already model-screened at creation. The deterministic rules run on every shot.

15. **The Phase 0 schema was applied via the Supabase management API**, not
   `drizzle-kit push`, because the database password is not retrievable through
   that API. The SQL applied is byte-for-byte the output of `pnpm db:generate`.
   Once `DATABASE_URL` is set, `pnpm db:push` should report no changes — which is
   the parity check.

16. **The Kling brief was mapped onto this stack rather than built beside it.**
    That brief names Next 14, Prisma, BullMQ on Redis, the AWS S3 SDK and
    `fluent-ffmpeg`; this project was already Next 15, Drizzle, Inngest, Supabase
    Storage and an ffmpeg render adapter, with the same Project → Episode → Scene
    → Shot → Character model and most of the same routes. Building the brief
    literally would have meant two ORMs, two queues and two object stores in one
    repository. Every phase keeps its intent and its acceptance criteria; only
    the named libraries differ. The substitutions, one for one:

    | Brief | Here | Why it is the same thing |
    |---|---|---|
    | Prisma | Drizzle | Both are typed ORMs over Postgres with versioned migrations. |
    | BullMQ + Redis | Inngest | Durable queue with retries and concurrency limits; Inngest keeps job state server-side, which is what makes the "kill the worker and it resumes" criterion hold. See deviation 31 for where the analogy stops. |
    | Kling on fal.ai | Kling on fal.ai | Unchanged — `lib/providers/fal/video.ts`, selected with `VIDEO_PROVIDER=fal`. |
    | S3 via AWS SDK v3 | Supabase Storage | S3-compatible, and reached only through `StorageProvider` — a raw-S3 adapter is one file. |
    | `fluent-ffmpeg` | the `ffmpeg` render adapter | Already behind `RenderProvider`, alongside the Shotstack cloud adapter. |

17. **`assets` *is* the GenerationJob table.** It already carries shot id,
    provider, external job id, status, error, cost and timestamps — plus the
    storage path of what the job produced. Splitting "the job" from "the file it
    produced" would create two rows that are always written and deleted together.
    The mapping is spelled out above the table in `lib/db/schema.ts`.

18. **Character reference stills are a table, not a `text[]`.** The upload goes
    straight from the browser to Storage on a presigned URL (Phase 2), so the
    server never sees the bytes and has to record what it verified out of band —
    content type and size need somewhere to live. `is_canonical` is a stored flag
    rather than a slice computed at every read site, so the generation job reads
    the canonical set through one partial index. The five-image cap is a CHECK
    constraint, not only a route-level rule.

19. **Reference stills upload in three steps, and only the last one is binding.**
    The client declares what it is about to send and gets one signed URL per
    file; it PUTs the bytes straight at Storage; it then confirms, and *that* is
    where the server reads back each object's real size and content type. The
    first check is a courtesy — a declared `bytes` is a claim — so the rules are
    enforced at three layers: the declaration (fast 400), the bucket itself
    (10MB, JPEG/PNG, which is the only layer on the path the bytes actually
    take), and the confirm, which deletes anything that fails inspection rather
    than recording a row for it. `pnpm db:buckets` now *updates* existing
    buckets instead of skipping them, because those bucket settings are
    load-bearing rather than cosmetic.

20. **"Minimum 1 reference image" is per upload request, not per character.**
    A character with no stills is normal and has to stay valid: the bible
    generates a whole cast at once, and an imported script does too. Enforcing a
    floor of one would make every generated character invalid the moment it was
    created. The rule as implemented is that an upload batch must contain at
    least one file and cannot take the character past five. Phase 4 falls back
    to text-to-video for a character with no canonical set.

21. **A partial reference set is treated as no reference set.** Below three
    stills nothing is flagged canonical. Conditioning the video model on one or
    two inconsistent stills is worse than conditioning on none, so the fallback
    is deliberate rather than a gap.

22. **The cast editor renders without a bible.** It used to sit behind the
    "no bible yet" empty state, which meant a series with a cast and no bible —
    an imported script, or the seed — had no way to reach its characters at all,
    and therefore no way to give them reference stills.

23. **`POST /api/episodes/:id/script` branches on whether you brought a script.**
    With a JSON body `{ text }` it stores that script verbatim; with no body it
    writes one and streams it back as SSE. Same resource, same operation from the
    user's side — "this episode's script is now X" — but one returns a document
    and the other an event stream, so they cannot share a handler. The raw text
    is kept in `episodes.script_text` *alongside* the structured `script`,
    because a breakdown is a lossy reading and re-running it needs the original
    rather than the last interpretation of it.

24. **The clip ceiling is enforced three times, and only the last one counts.**
    The prompt asks the model to split a long beat, the schema refuses anything
    over 15 seconds, and `splitLongShots` splits it anyway. Belt and braces,
    because a shot over the ceiling is not a shot that looks worse — it is a shot
    that cannot be generated at all. Splits divide evenly (22s → 11 + 11, not
    15 + 7) and only the first part keeps the dialogue, or TTS would speak the
    line twice.

25. **`MAX_CLIP_SECONDS` (15) is not `MAX_SHOT_SECONDS` (8).** The first is
    Kling's technical per-clip limit and applies to a script the user brought,
    whose shots are as long as they are. The second is an editorial ceiling for
    coverage the model plans from nothing, where 8 seconds is already a long
    time to hold in vertical. Breakdown durations are snapped to the provider's
    grid but *not* refitted toward an episode budget the way a generated
    storyboard is — an imported script is not trying to hit 60 seconds.

26. **Regeneration preserves whole scenes, not individual shots.** A scene
    holding anything queued, generating or finished is left completely alone —
    rows, prompts, order within the scene. Rebuilding the rest of a scene around
    an in-flight shot would renumber it, which lands a finished clip at the wrong
    point in the cut. `queued` is protected alongside the spec's `generating` and
    `ready` because deleting a queued shot does not cancel the job about to run
    it; the worker would wake to find its shot gone.

27. **A preserved scene the new breakdown no longer mentions is kept, not
    deleted.** It moves to the end of the episode and the diff says so. Throwing
    away a paid-for clip on the strength of the model re-reading a scene boundary
    differently is not a trade worth making silently.

28. **`[[stub:malformed]]` was added to the stub language model.** The existing
    markers make a provider call *fail*; this one makes it succeed, bill, and
    return prose. That is the realistic bad day for a model asked for structured
    output, and it is the only way to exercise "reject, surface the raw output,
    persist nothing" without waiting for the real model to have one.

29. **A provider outage is no longer reported as a schema failure.**
    `JsonGenerationError` is raised both when the model answers badly and when it
    never answers at all, and the breakdown route used to describe both as "the
    output did not match the schema". It now carries a `kind`, and an unreachable
    model surfaces as a 502 quoting the provider — found the hard way, when an
    Anthropic account with no credit left produced a confident, entirely wrong
    diagnosis about the prompt.

30. **Tests that resolve their own provider must pin `LLM_PROVIDER=stub`.**
    `getLlmProvider()` falls back to `anthropic` whenever `ANTHROPIC_API_KEY` is
    set, which it is in any working `.env.local`. Suites that pass a
    `StubLlmProvider` explicitly are unaffected; ones that go through a service
    which resolves its own provider — `runBreakdown` — will otherwise call the
    real API on every run, billed and non-deterministic.

31. **The concurrency cap is declared at the queue *and* leased in the database,
    and only the second one holds.** The spec asks for a queue-level rate
    limiter rather than an app-level semaphore, and the Inngest `concurrency`
    key on `event.data.seriesId` is exactly that. It is not sufficient here:
    every `step.sleep` in the poll loop hands the slot back, so a 20-shot
    episode once submitted all 20 clips before the first finished — a measured
    peak of 20 live jobs against a stated limit of 3. A BullMQ worker that
    blocks while polling would not have this problem; Inngest's steps do not
    block, and that is the whole difference. `claimVideoSlot` is the lease that
    makes the cap true, counted where the work actually is.

32. **`version` and `retry_count` are different numbers.** A retry is another go
    at the same take and overwrites; a version is a new take the user asked for
    and must not. So `/shots/:id/generate` re-attempts the current take and
    `/shots/:id/regenerate` starts a new one — separate routes rather than a
    flag, because the two want opposite things from the previous clip and a
    boolean makes it too easy to pick the wrong one. Storage paths carry both
    (`.../v{version}/a{attempt}.mp4`), so pruning a take is a prefix operation.

33. **Reference stills are signed for six hours, not the usual one.** The
    provider fetches the image when it picks the job up, which can be minutes
    after submission on a busy queue. The failure mode of an expired URL — a
    clip rendered with no reference, so the character's face quietly changes —
    is one nobody would ever attribute to a signature TTL.

34. **The fal job id carries the model and the clip length, not just the request
    id.** fal's status endpoint hangs off the *application* (`fal-ai/kling-video`),
    not the variant, and fal reports no per-request cost. Encoding both in the
    id is what makes polling stateless: a restarted worker can finish a job it
    knows nothing else about, which is AC #3 as a property of the data rather
    than of the process.

35. **Kling's real duration grid (5s, 10s) is below `MAX_CLIP_SECONDS` (15).**
    A 15-second shot is legal to plan and renders as 10, because every path
    snaps durations through `clampDuration`. The mismatch shows up as a shorter
    clip, never as a rejected request.

36. **Only the first canonical still is sent as `image_url`.** Kling's
    image-to-video endpoint conditions on one image. The whole set travels as
    `reference_image_urls` for model versions that read it, and is recorded on
    the asset either way — dropping the rest silently would make a one-still
    character indistinguishable from a three-still one after the fact. Whether
    the extra stills are actually used is the model's business; `FAL_KLING_EXTRA_INPUT`
    is there for schema differences rather than guessing at them in code.

37. **A shot with no canonical set falls back to text-to-video, and says so.**
    The chosen mode is written to `assets.meta` as well as logged, because "did
    this shot actually condition on the character's face" is otherwise
    unanswerable later — and a silent fallback looks exactly like a working
    pipeline until you notice the face changed.

38. **`claimVideoSlot`'s first argument changed from a user id to a series id,
    and TypeScript could not see it.** Both are `string`, so two existing
    call sites in `tests/readiness-db.test.ts` compiled fine and silently
    stopped counting anything, admitting five jobs against a cap of three. The
    tests caught it; the compiler never could. A branded id type would have.

39. **`/assemble` and `/render` are one operation with two names.** The spec
    calls it assembly; this codebase has called it rendering since Phase 4 and
    the export panel calls `/render`. Both routes are two lines over
    `startAssembly`. Two names is a small wart; two implementations would be a
    real one.

40. **An unassemblable episode returns 409, not 400.** Nothing about the request
    is malformed — the episode is simply in a state where this cannot happen
    yet, and will be able to later without the caller changing anything. That
    distinction is what tells a client whether retrying is pointless. The body
    carries `incompleteShotIds` and a richer `blockingShots` with a reason per
    shot.

41. **The refusal happens before anything is submitted.** Not "we start and then
    stop": a partial episode encodes perfectly well and is indistinguishable
    from a finished one at the file level, so it would be uploaded, marked
    `rendered`, and discovered by a human watching it. No render row, no queued
    job, no file.

42. **The music level is a dB figure, not a linear gain.** It was `volume=0.18`
    (≈ -14.9dB) hardcoded; it is now `volume=-18dB` and settable with
    `MUSIC_BED_LEVEL_DB`. dB is the unit the requirement is written in and the
    unit anyone adjusting it thinks in — "a bit quieter" is 3dB to a person and
    an unmemorable multiplication to a filtergraph. A positive value is refused
    rather than clamped, because above 0dB the bed is louder than the dialogue
    and nobody means that.

43. **Ducking happens before the mix, and the mix before `loudnorm`.** So -18dB
    is a ratio between the two sources rather than an absolute output level;
    the normaliser then brings the whole mix to -14 LUFS with the balance
    preserved. Attenuating after the mix would quieten the voice by the same
    amount and change nothing.

44. **`episodes.output_storage_path` and `episodes.duration_seconds` duplicate
    the latest successful `renders` row.** `renders` is the attempt log —
    several rows per episode, most failed or superseded — and "where is this
    episode's video" should not require knowing that, nor a scan to find the
    newest ready one. The column is the answer; the log is the history.

45. **The assembly criteria are verified by looking inside the file.** "Shots in
    the right order" is asserted by scaling the frame at 1s and at 4s down to a
    single pixel and reading its colour; "audibly mixed" by measuring the
    stretch of programme where the dialogue has stopped — silence without a
    bed, audible music with one. Asserting on the filtergraph string would have
    proved only that the code says what it says.

46. **The whole project is one tree on one page.** The spec asks to navigate
    Project → Episode → Scene → Shot; four pages would have satisfied that and
    been the wrong shape. What a reviewer actually does is scan for what is
    wrong — a failed shot, a scene still generating — and that is a
    whole-project question, so the tree collapses rather than paginates. The
    shot detail is a dialog over it for the same reason: you come back to the
    board.

47. **Thumbnails are the clip's own first frame, not a stored image.** The
    `#t=0.1` fragment makes the browser seek there while loading metadata and
    paint it as the poster. Generating and storing a separate thumbnail per take
    would mean another object per clip to upload, sign, version and prune in
    step with it — for a picture the browser will decode anyway.

48. **Reverting is a pointer move.** `shots.version` is the only thing that
    changes; nothing is re-rendered, re-charged or re-queued, because the clip
    already exists. That is what versions are *for*, and it is why undoing a
    regeneration you did not like is instant and free. Only a take that actually
    produced a clip can be reverted to — a failed version is in the history so
    you can see that it failed, not so you can switch to it.

49. **Previewing a take is not reverting to it.** Clicking a version in the
    history strip loads it in the player without committing; Revert commits. A
    board poll landing mid-preview does not yank the player back to the active
    take, because the user is deliberately looking at something.

50. **An idle board still polls, slowly.** Polling only while *this page* knows
    something is moving means a board never notices work started anywhere else —
    another tab, or a job queued before the page loaded — and silently stops
    reflecting reality. Five seconds while active, thirty when idle. Found by
    testing an external status change against an idle board and watching nothing
    happen.

51. **The poll is fixed-rate, not fixed-delay.** Waiting the full interval
    *after* each response made the real cycle the interval plus a round trip —
    measured at 5.7s against a stated 5s, which is the difference between
    meeting "updates within five seconds" and narrowly missing it. Subtracting
    the last request's duration brought it to 5.01s.

53. **The autorun sits on top of the six phases, not instead of them.** Every
    stage calls the same `generate…`/`persist…` pair the manual UI calls, so a
    run and a hand-built series produce identical rows. That is what lets a run
    die at stage four and leave three stages of ordinary, editable work behind —
    a `runs` row is the record of an attempt, not a container for its output.

54. **Gates are skippable, not optional.** At `bible` and `storyboard` the run
    pauses on `step.waitForEvent` with a timeout, so silence means continue.
    Those two points are where being wrong is expensive *and* invisible until
    much later: a wrong bible makes the whole cast and every scene wrong, a
    wrong shot list makes 36 clips wrong. Everything else is mechanical or
    cheap. `shots` is deliberately *not* gated — it would ask twice for one
    decision the storyboard gate already covers.

55. **Spend is checked against the worst case, not the expected one.** A run
    that stops two-thirds through for want of budget has spent the money and
    produced nothing watchable, so a 3-minute run needs the $28 ceiling free,
    not the $17 estimate.

56. **The expensive stage is polled, not awaited.** Shot generation fans out to
    per-shot jobs with their own retries and concurrency cap, so the supervisor
    waits on the *rows*. A shot retried automatically — or regenerated by hand
    from the review board mid-run — is then accounted for correctly, which
    counting events could not do.

57. **The cost is quoted before the run, and it moves with the length.**
    `GET /api/runs/estimate` exists separately from `POST /api/runs` because
    quoting only at the moment of commitment tells someone what they have
    already decided to spend. Almost all of it is video — $16.20 of $17.22 for
    three minutes — so the breakdown is shown rather than a single number.

58. **Character stills are generated from the appearance prompt, and three of
    them share a seed.** That is the cheapest thing that helps, not a guarantee:
    one seed and three framing instructions give three *related* images, not
    three photographs of one person. True identity lock needs an
    identity-preserving model. It is why the canonical set is three images and
    why the cast gate exists.

59. **Concurrency, not shot planning, is what makes a long film slow.** The
    duration fitter already lands a 60s, 3-minute, 5-minute or 10-minute target
    at exactly the target — measured 0% drift at all four. What does not scale is
    the wall clock: 36 clips three at a time is ~25 minutes, and ten minutes of
    film at three is over two hours. `VIDEO_CONCURRENCY` is therefore the one
    lever worth exposing, and both the lease and the Inngest `concurrency` option
    read the same constant so they cannot disagree — two different numbers would
    mean the queue admitting work the lease then refuses.

60. **The estimate quotes time as well as money.** A "3-minute film" that takes
    27 minutes to make is where someone decides the app has hung. Cost and time
    move independently: raising concurrency shortens the run and changes the bill
    not at all, which is exactly what the test asserts.

61. **The supervisor's shot timeout is derived, not fixed.** A flat 30 minutes
    was right for a 60-second short and would abandon a 3-minute film around
    halfway — money spent, film unfinished, which is the worst available outcome.
    It now budgets four minutes per batch against a nominal two, from the shot
    count that actually exists rather than the one that was planned.

62. **`tests/video-concurrency.test.ts` uses dynamic imports on purpose.** ESM
    hoists `import` above every statement in the module body, so setting
    `process.env` at the top of a file runs *after* the module that reads it has
    loaded. The first version of that test asserted 8 and got 3 for exactly this
    reason.

64. **Regenerating a character's stills used to orphan the previous set.**
    `generateCharacterPortraits` replaces the row set, and replaced the rows
    only — three images left in the bucket per regeneration, with nothing
    pointing at them. Invisible, because the UI reads rows. Found by sweeping
    for unreferenced objects after a verification run, not by any test. It now
    deletes storage first, matching every other path that owns both.

65. **Test teardown deletes by user, not by row.** A `beforeEach` that drops the
    series cascades away the characters, and with them any record of which
    objects were theirs — so teardown that walked the cast could only ever clean
    up after the *last* test in a file. That is where 126 orphaned objects came
    from. Every path in this codebase starts with the owning user's id, which is
    the one handle that outlives the rows, so `tests/support/storage.ts` deletes
    by that. It reaches for the admin client rather than `StorageProvider`
    deliberately: the interface hides folders from `list` because nothing in the
    app walks a tree, and bending it for teardown would be the tail wagging the
    dog.

67. **A character's stills are generated hero-first, then conditioned on that
    face.** Three images from one prompt and one seed are three people who match
    a description; two of them generated from the *first one's photograph* are
    one person in three poses. That ordering is the whole mechanism, and it
    costs an extra round trip — the hero has to be stored and signed before the
    rest can reference it.

68. **`supportsIdentity` is declared, not inferred.** A reference passed to a
    model that ignores it produces exactly the drift the reference exists to
    remove, with nothing to distinguish the result from a set that worked. So
    providers declare the capability, callers degrade deliberately, and
    `identityLocked` comes back on the result and into the toast — because a set
    that drifted looks identical to one that did not until thirty clips later.

69. **The identity reference is sent under two field names.** PuLID calls it
    `reference_image_url`; InstantID and IP-Adapter FaceID call it `image_url`.
    They are mutually exclusive in practice — a model reads the one it knows —
    and guessing wrong drops the reference in silence.

70. **Multi-character shots are fixed by drawing the shot, not the person.**
    Kling conditions on one image per clip, so sending a character's portrait
    meant a two-hander preserved only the first-billed face — *and* every clip
    opened on a grey studio backdrop it had to travel out of in five seconds.
    Both are the same mistake: conditioning on a picture of a person when what
    is needed is a picture of the shot. Each shot now gets a **keyframe** drawn
    from its own prompt with every character's stills as identity references,
    and that becomes the start frame. (Half of this is now handled better
    upstream — see #75.)

71. **`identityCapacity` is declared, and `facesUsed` is recorded.** "We sent
    two references" and "the model conditioned on two" are different claims, and
    only the second fixes a two-hander. PuLID and InstantID read one, so with
    them the second character still comes from the prompt — the asset row says
    so rather than implying otherwise. Raising `FAL_IMAGE_IDENTITY_CAPACITY`
    against a multi-identity model is the only change needed to lock both.

72. **The capacity setting is clamped to what the model is known to read.** It
    describes the configured model; it does not grant it a capability. Setting 4
    against PuLID does not produce four conditioned faces — it produces one face
    and a wrong number in the asset row, which is the exact failure the number
    exists to expose, reintroduced through its own setting. Known
    single-identity models are matched by pattern and clamped with a warning;
    unrecognised models are trusted, because refusing them would make every new
    model unusable until the list caught up.

73. **The keyframe is booked as an asset.** It is stored and it costs money, and
    the spend ledger reconciles against `assets.cost_cents` — so it gets an
    `image` row and its own `usage_log` entry. Recording the charge without a
    row would break that invariant; recording neither would understate a film by
    one image per shot. It also moves the quote: a 3-minute film went from
    $17.22 to **$19.26**, and the cast line rose because the set is now drawn at
    the identity rate.

74. **`/api/health` reports the queue, and says when it did not probe it.** The
    brief asks for Redis connection status. Locally the equivalent is the Inngest
    dev server, which has a `/health` endpoint worth pinging. In production the
    queue is Inngest Cloud, which exposes no unauthenticated probe — so that
    branch reports that the app is configured to reach it and sets
    `probed: false`, rather than claiming a connection it never made.

75. **Identity belongs at the video call, not at the frame before it.** The
    keyframe above was built on the belief that Kling conditions on exactly one
    image, so several faces had to be composited into that image first. It does
    not: `elements` takes a group of stills *per character*, and the prompt
    points at them by position. Checking fal's OpenAPI schema rather than its
    prose also turned up that the start frame had been going under a field name
    the endpoint does not define — `image_url` instead of `start_image_url` — so
    every image-to-video call ever made was malformed, invisibly, because the
    path had never run against live fal.

76. **The keyframe stayed anyway, with its job cut in half.** Elements say who
    is in the clip and nothing about where it is or how it is framed, and a clip
    that opens already in the harbour terminal is worth an image per shot. So
    both are sent: the keyframe as `start_image_url` for composition, the
    elements for identity. It is still drawn *with* identity conditioning, even
    though identity is now held downstream — a first frame showing different
    faces than the elements would put the two instructions in conflict on frame
    one. `SHOT_KEYFRAMES=off` now costs composition and not character
    consistency, which is a different trade than the one that setting used to
    describe.

77. **Rewriting the prompt is the risky part, so it was checked against real
    prompts.** Kling matches elements by position (`@Element1`), and our prompts
    name people in prose a language model wrote. The substitution is whole-word,
    any script, any case, full names before bare first names, and refuses to
    guess when two characters share a first name — a wrongly tagged face is
    worse than an untagged mention, and neither is visible until the clip
    exists. Run over 40 real storyboard prompts: 41 of 42 cast slots tagged by
    name, one introduced by the fallback clause.

78. **`castCapacity` is read off the model, not asserted by the adapter.** The
    Kling generations differ in ways that fail silently: v1.6, v2.1 and v2.5
    take the start frame as `image_url` and have no `elements` field, while v3
    and o1 take `start_image_url` and do. Pinning an older model through
    `FAL_KLING_IMAGE_TO_VIDEO_MODEL` is legitimate and quietly removes
    multi-character identity, so the capability comes from the configured id.
    An unknown model is assumed newer rather than older — the opposite guess
    degrades a capable model to a start frame it cannot read.

79. **`generate` returns what only the adapter knows.** `elementsUsed` against
    `castRequested`, plus any name the prompt never used, land on the asset row.
    A gap between those two numbers is a shot where somebody was *described*
    rather than *held*, which renders perfectly and drifts — the only failure
    mode here that looks like success. The submit step also carries that meta
    forward to the ready branch, because `updateAsset` replaces `meta` rather
    than merging it, and a finished clip would otherwise be the one row that no
    longer says what it was conditioned on.

## Assets

Everything generated, in one place, reusable. `/assets`.

Four things produce stored objects and none knew about each other: a shot's
clips and keyframes, a character's reference stills, an episode's finished cuts,
and voice tracks. They live in different tables because they have different
owners and lifetimes — which is right, and left no answer to "what have I made",
and no way to use a picture you already paid for in a shot that needs one.

80. **Reuse copies the object; it never points at it.** `pruneShotVersions`
    deletes the objects of every take beyond the last three. A character
    reference pointing at a shot's keyframe would therefore lose its face the
    fourth time that shot was regenerated — days later, as a broken image, with
    nothing linking it to the regeneration that caused it. A copy costs cents a
    month and buys an asset whose lifetime belongs to whoever reused it. It is
    also what lets an asset cross series, since ownership here is by path.

81. **A pinned start frame is not a take, so pruning leaves it alone.** Pruning
    is a rule about outputs — the fourth regeneration makes the first
    uninteresting. A pinned frame is an *input* to future takes, chosen by a
    person. Deleting it by version count would send the shot back to drawing its
    own keyframe, silently, having been told not to.

82. **Reuse is free, and recorded as free.** The image was paid for when it was
    generated. A pinned keyframe is written with `cost_cents: 0`, because
    charging again would double-count against the spend cap and overstate what
    the film cost. It also saves the ~5c the job would have spent drawing a
    keyframe it was about to be handed.

83. **Every failure path after the copy deletes the copy.** An object with no row
    is invisible: not in this library, not deleted with its owner, and visible
    only as a line on a storage bill. This project has already paid that debt
    once — a sweeper and 510 deletions — and the ordering rules here are the
    lesson. Rows first, then storage, except when replacing a pin, where the
    superseded object goes only after the new row has committed: a rollback that
    restored a row pointing at a deleted object would be unrecoverable, while a
    leftover object is one `pnpm orphans` away.
