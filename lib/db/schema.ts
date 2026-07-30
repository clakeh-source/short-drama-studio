import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';

/* -------------------------------------------------------------------------- */
/* Shared column helpers                                                      */
/* -------------------------------------------------------------------------- */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const seriesStatus = pgEnum('series_status', ['draft', 'active', 'archived']);

/**
 * Whether the scripts in this series are written by the model or supplied by the
 * user. Only the *route in* differs — both produce the same script shape, so
 * nothing downstream of the script branches on it.
 */
export const scriptSource = pgEnum('script_source', ['generated', 'user_provided']);

export const episodeStatus = pgEnum('episode_status', [
  'draft',
  'scripted',
  'storyboarded',
  'generating',
  'rendered',
  'failed',
]);

export const shotStatus = pgEnum('shot_status', [
  'pending',
  'queued',
  'generating',
  'ready',
  'failed',
]);

export const assetKind = pgEnum('asset_kind', ['video', 'image', 'voice', 'music', 'sfx']);

/**
 * The stages an unattended run walks through, in order.
 *
 * Named for what they produce rather than which service they call, because the
 * user watching a progress bar cares that the cast is being drawn, not that a
 * diffusion model is being polled.
 */
export const runStage = pgEnum('run_stage', [
  'bible',
  'cast',
  'script',
  'storyboard',
  'shots',
  'assemble',
  'done',
]);

export const runStatus = pgEnum('run_status', [
  'pending',
  'running',
  /** Paused at a gate, counting down. Continues on its own if nobody acts. */
  'awaiting_gate',
  'completed',
  'failed',
  'cancelled',
]);

export const jobStatus = pgEnum('job_status', [
  'pending',
  'queued',
  'generating',
  'ready',
  'failed',
]);

/* -------------------------------------------------------------------------- */
/* RLS predicates                                                             */
/*                                                                            */
/* Every row is reachable from exactly one series.user_id. Child tables walk   */
/* up to it with an EXISTS subquery; the supporting FK indexes below keep that */
/* cheap. Policies apply to the `authenticated` role only — the service role   */
/* bypasses RLS by design and is used solely by trusted server jobs.           */
/* -------------------------------------------------------------------------- */

/*
 * Two things every predicate here has to get right.
 *
 * 1. `col` must be written table-qualified (e.g. "shots.scene_id") so it
 *    unambiguously refers to the row the policy is being evaluated against. An
 *    unqualified name can bind to an alias inside the subquery instead, which
 *    silently turns the predicate into a tautology and disables RLS.
 *
 * 2. `auth.uid()` is wrapped in a scalar subquery. Called bare, Postgres treats
 *    it as volatile and re-evaluates it for every row examined; wrapped, it is
 *    evaluated once and cached for the whole query. Supabase measures this at
 *    5-10x on large tables, and it costs nothing to get right.
 */
const UID = '(select auth.uid())';

const ownsSeries = (col: string) =>
  sql.raw(`exists (select 1 from series s where s.id = ${col} and s.user_id = ${UID})`);

const ownsEpisode = (col: string) =>
  sql.raw(
    `exists (select 1 from episodes e join series s on s.id = e.series_id ` +
      `where e.id = ${col} and s.user_id = ${UID})`,
  );

/** Walks character → series. Takes the child's character_id, never its id. */
const ownsCharacter = (col: string) =>
  sql.raw(
    `exists (select 1 from characters c ` +
      `join series s on s.id = c.series_id ` +
      `where c.id = ${col} and s.user_id = ${UID})`,
  );

/** Walks scene → episode → series. Takes the shot's own scene_id, never its id. */
const ownsScene = (col: string) =>
  sql.raw(
    `exists (select 1 from scenes sc ` +
      `join episodes e on e.id = sc.episode_id ` +
      `join series s on s.id = e.series_id ` +
      `where sc.id = ${col} and s.user_id = ${UID})`,
  );

/** One policy covering select/insert/update/delete for the owning user. */
function ownerPolicy(name: string, predicate: ReturnType<typeof sql.raw>) {
  return pgPolicy(name, {
    for: 'all',
    to: authenticatedRole,
    using: predicate,
    withCheck: predicate,
  });
}

/* -------------------------------------------------------------------------- */
/* series                                                                     */
/* -------------------------------------------------------------------------- */

export const series = pgTable(
  'series',
  {
    id: id(),
    // auth.users.id. Intentionally not a DB-level FK — see README "Deviations".
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    logline: text('logline').notNull().default(''),
    genre: text('genre').notNull().default(''),
    tone: text('tone').notNull().default(''),
    audience: text('audience').notNull().default(''),
    language: text('language').notNull().default('en'),
    episodeTargetCount: integer('episode_target_count').notNull().default(1),
    episodeTargetSeconds: integer('episode_target_seconds').notNull().default(60),
    bible: jsonb('bible'),
    /**
     * Burned-in caption preset for this series. A user setting, so it gets its
     * own column rather than living inside the model-generated bible document.
     */
    captionStyleId: text('caption_style_id').notNull().default('short-drama'),
    /** Optional music bed, as `bucket/path` in Storage. */
    musicStoragePath: text('music_storage_path'),
    /** Defaults to `generated` so every series that predates the import flow
     *  keeps describing itself correctly. */
    scriptSource: scriptSource('script_source').notNull().default('generated'),
    status: seriesStatus('status').notNull().default('draft'),
    ...timestamps,
  },
  (t) => [
    index('series_user_id_idx').on(t.userId),
    ownerPolicy('series_owner_all', sql.raw(`series.user_id = ${UID}`)),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* characters                                                                 */
/* -------------------------------------------------------------------------- */

export const characters = pgTable(
  'characters',
  {
    id: id(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull().default(''),
    description: text('description').notNull().default(''),
    /** Reused verbatim in every shot prompt the character appears in. */
    appearancePrompt: text('appearance_prompt').notNull().default(''),
    /** TTS provider voice id. */
    voiceId: text('voice_id'),
    ...timestamps,
  },
  (t) => [
    index('characters_series_id_idx').on(t.seriesId),
    ownerPolicy('characters_owner_all', ownsSeries('characters.series_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* character_reference_images                                                 */
/*                                                                            */
/* Stills the user uploads of a character, used as Kling's image-to-video      */
/* consistency input so the same face survives across shots.                   */
/*                                                                            */
/* A table rather than a text[] on `characters` for two reasons. The upload    */
/* goes straight from the browser to Storage on a presigned URL, so the server */
/* never sees the bytes and has to record what it verified out-of-band —       */
/* content type and size need somewhere to live. And "canonical set" is a flag */
/* the app maintains, not a slice computed at every read site.                 */
/* -------------------------------------------------------------------------- */

export const characterReferenceImages = pgTable(
  'character_reference_images',
  {
    id: id(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** `bucket/path`, matching `assets.storage_path`. */
    storagePath: text('storage_path').notNull(),
    /** Verified server-side after upload, not taken from the client's word. */
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    orderIndex: integer('order_index').notNull(),
    /**
     * Whether this still is part of the canonical set fed to Kling.
     *
     * Maintained by the app: the first CANONICAL_REFERENCE_SET_SIZE images by
     * order_index are flagged once a character has at least that many, and none
     * are flagged below it. Stored rather than derived so the generation job can
     * read the set with a single indexed predicate. The rule itself lives in
     * lib/characters/references.ts.
     */
    isCanonical: boolean('is_canonical').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('character_reference_images_character_order_idx').on(t.characterId, t.orderIndex),
    // The generation job's lookup: this character's canonical stills, nothing else.
    index('character_reference_images_canonical_idx')
      .on(t.characterId)
      .where(sql`is_canonical`),
    // Attaching the same object twice would silently double a character's
    // weighting in the canonical set.
    unique('character_reference_images_path_uq').on(t.characterId, t.storagePath),
    // The max-5 rule, structurally: MAX_REFERENCE_IMAGES in
    // lib/characters/references.ts, written here as a literal because a
    // migration cannot import TypeScript. The route returns a 400 long before
    // this fires; the constraint is what makes the rule true of the data
    // regardless of who is writing.
    check('character_reference_images_order_bounds', sql`order_index between 0 and 4`),
    ownerPolicy(
      'character_reference_images_owner_all',
      ownsCharacter('character_reference_images.character_id'),
    ),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* episodes                                                                   */
/* -------------------------------------------------------------------------- */

export const episodes = pgTable(
  'episodes',
  {
    id: id(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull().default(''),
    synopsis: text('synopsis').notNull().default(''),
    hook: text('hook'),
    cliffhanger: text('cliffhanger'),
    /**
     * The screenplay as written, before anything interpreted it.
     *
     * Kept alongside the structured `script` rather than replaced by it: the
     * breakdown is a lossy reading of this text, so re-running it — or running a
     * better one later — needs the original, not the last interpretation of it.
     * Null for episodes whose script was generated rather than brought.
     */
    scriptText: text('script_text'),
    script: jsonb('script'),
    /**
     * The assembled episode, as `bucket/path`.
     *
     * Duplicated from the latest successful `renders` row on purpose. `renders`
     * is the attempt log — several rows per episode, most of them failed or
     * superseded — and "where is this episode's video" should not require
     * knowing that, nor a scan to find the newest ready one. This is the
     * answer; the log is the history.
     */
    outputStoragePath: text('output_storage_path'),
    /** Length of the assembled episode, in seconds. Null until one exists. */
    durationSeconds: integer('duration_seconds'),
    status: episodeStatus('status').notNull().default('draft'),
    ...timestamps,
  },
  (t) => [
    index('episodes_series_id_idx').on(t.seriesId),
    unique('episodes_series_number_uq').on(t.seriesId, t.number),
    ownerPolicy('episodes_owner_all', ownsSeries('episodes.series_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* scenes                                                                     */
/* -------------------------------------------------------------------------- */

export const scenes = pgTable(
  'scenes',
  {
    id: id(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull(),
    location: text('location').notNull().default(''),
    timeOfDay: text('time_of_day').notNull().default(''),
    summary: text('summary').notNull().default(''),
    ...timestamps,
  },
  (t) => [
    index('scenes_episode_id_order_idx').on(t.episodeId, t.orderIndex),
    ownerPolicy('scenes_owner_all', ownsEpisode('scenes.episode_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* shots                                                                      */
/* -------------------------------------------------------------------------- */

export const shots = pgTable(
  'shots',
  {
    id: id(),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull(),
    durationSeconds: integer('duration_seconds').notNull().default(5),
    camera: text('camera').notNull().default('medium'),
    action: text('action').notNull().default(''),
    dialogue: text('dialogue'),
    speakerCharacterId: uuid('speaker_character_id').references(() => characters.id, {
      onDelete: 'set null',
    }),
    characterIds: uuid('character_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * Names the script used that no Character in this series answers to.
     *
     * A script breakdown routinely names people the cast list does not have —
     * a walk-on, a voice on a phone, a spelling that drifted. Dropping them
     * silently was the tempting option and the wrong one: the shot then claims
     * nobody is in it, and the user has no way to find out that a character was
     * lost. Kept here so the UI can offer to link or create them.
     */
    unmatchedCharacters: text('unmatched_characters')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    imagePrompt: text('image_prompt'),
    videoPrompt: text('video_prompt'),
    negativePrompt: text('negative_prompt'),
    /** User edit of video_prompt. Survives storyboard regeneration (Phase 2). */
    promptOverride: text('prompt_override'),
    status: shotStatus('status').notNull().default('pending'),
    /** Automatic retries inside the *current* version. Reset when a version is. */
    retryCount: integer('retry_count').notNull().default(0),
    /**
     * Which take of this shot is current.
     *
     * Distinct from `retry_count`, and the distinction is load-bearing. A retry
     * is the same take attempted again after something went wrong, and it
     * overwrites; a version is a *new* take the user asked for because they did
     * not like the last one, and it must not. Only the version-bumping path
     * keeps history, which is why regenerating is a different endpoint from
     * generating.
     */
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('shots_scene_id_order_idx').on(t.sceneId, t.orderIndex),
    // FK, and an ON DELETE SET NULL target — without this, deleting a character
    // scans every shot in the account.
    index('shots_speaker_character_id_idx').on(t.speakerCharacterId),
    ownerPolicy('shots_owner_all', ownsScene('shots.scene_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* assets                                                                     */
/*                                                                            */
/* One row per outbound generation call — this is the GenerationJob record.    */
/* It is named `assets` because a successful job *is* its output; splitting    */
/* "the job" from "the file it produced" would mean two rows that are always   */
/* created and deleted together.                                              */
/*                                                                            */
/*   shot id           shot_id                                                */
/*   provider          provider                                               */
/*   external job id   provider_job_id   (the fal.ai request id, from Phase 4) */
/*   status            status                                                 */
/*   error message     error                                                  */
/*   cost              cost_cents                                             */
/*   timestamps        created_at / updated_at                                */
/*   output video URL  storage_path      (our copy, never the provider's CDN)  */
/*                                                                            */
/* A shot's current video is therefore its latest ready video asset, not a     */
/* column on `shots` — which is what lets Phase 4 keep prior versions.         */
/* -------------------------------------------------------------------------- */

export const assets = pgTable(
  'assets',
  {
    id: id(),
    shotId: uuid('shot_id').references(() => shots.id, { onDelete: 'cascade' }),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    kind: assetKind('kind').notNull(),
    provider: text('provider').notNull(),
    /**
     * The take this output belongs to, matching `shots.version`.
     *
     * Assets are never updated across versions — a regeneration writes new rows
     * — so this is what makes "keep the last three takes and prune the rest" a
     * query rather than a guess about storage paths.
     */
    version: integer('version').notNull().default(1),
    providerJobId: text('provider_job_id'),
    storagePath: text('storage_path'),
    durationSeconds: integer('duration_seconds'),
    costCents: integer('cost_cents').notNull().default(0),
    status: jobStatus('status').notNull().default('pending'),
    error: text('error'),
    meta: jsonb('meta'),
    ...timestamps,
  },
  (t) => [
    index('assets_shot_id_idx').on(t.shotId),
    index('assets_episode_id_idx').on(t.episodeId),
    // The version-history read, and the prune's "which takes are old" scan.
    index('assets_shot_version_idx').on(t.shotId, t.kind, t.version),
    ownerPolicy('assets_owner_all', ownsEpisode('assets.episode_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* renders                                                                    */
/* -------------------------------------------------------------------------- */

export const renders = pgTable(
  'renders',
  {
    id: id(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerJobId: text('provider_job_id'),
    storagePath: text('storage_path'),
    durationSeconds: integer('duration_seconds'),
    costCents: integer('cost_cents').notNull().default(0),
    status: jobStatus('status').notNull().default('pending'),
    error: text('error'),
    /** Always carries { ai_generated: true } — cross-cutting disclosure rule. */
    meta: jsonb('meta'),
    ...timestamps,
  },
  (t) => [
    index('renders_episode_id_idx').on(t.episodeId),
    ownerPolicy('renders_owner_all', ownsEpisode('renders.episode_id')),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* listings                                                                   */
/*                                                                            */
/* Source rows for the Shotstack template batch renderer                      */
/* (scripts/shotstack/render-batch.mjs). Each row renders to one video; the    */
/* render columns below are that script's resume state, so an interrupted      */
/* batch resumes by re-running it. Column names are the template's merge       */
/* fields lowercased — the renderer maps them by name.                         */
/* -------------------------------------------------------------------------- */

export const listings = pgTable(
  'listings',
  {
    id: id(),
    // auth.users.id, matching `series` — intentionally not a DB-level FK.
    userId: uuid('user_id').notNull(),

    address: text('address').notNull(),
    suburb: text('suburb').notNull().default(''),
    state: text('state').notNull().default(''),
    postcode: text('postcode').notNull().default(''),
    /** Maps to the template's TYPE field: AUCTION, FOR SALE, … */
    listingType: text('listing_type').notNull().default('FOR SALE'),
    bedrooms: integer('bedrooms').notNull().default(0),
    bathrooms: integer('bathrooms').notNull().default(0),
    carports: integer('carports').notNull().default(0),

    /** Public URLs, in slideshow order. The template shows the first five. */
    images: text('images').array().notNull().default(sql`'{}'::text[]`),

    agentName: text('agent_name').notNull().default(''),
    agentEmail: text('agent_email').notNull().default(''),
    agentPicture: text('agent_picture').notNull().default(''),
    agencyLogo: text('agency_logo').notNull().default(''),

    /** Render state. Null render_id means "never submitted". */
    shotstackRenderId: text('shotstack_render_id'),
    videoUrl: text('video_url'),
    renderedAt: timestamp('rendered_at', { withTimezone: true }),
    renderError: text('render_error'),

    ...timestamps,
  },
  (t) => [
    index('listings_user_id_idx').on(t.userId),
    // The renderer's work queue: rows for this user with no video yet.
    index('listings_user_rendered_idx').on(t.userId, t.renderedAt),
    ownerPolicy('listings_owner_all', sql.raw(`listings.user_id = ${UID}`)),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* runs                                                                       */
/*                                                                            */
/* One unattended prompt-to-film run.                                         */
/*                                                                            */
/* The series, episodes, scenes and shots a run produces are ordinary rows —   */
/* a run is not a container for them, it is the record of the attempt that     */
/* made them. So a run can fail at stage four and leave three stages' worth of */
/* perfectly good work behind, editable by hand exactly as if it had been made */
/* that way. That is the whole reason the autorun sits *on top of* the phased  */
/* pipeline instead of replacing it.                                          */
/* -------------------------------------------------------------------------- */

export const runs = pgTable(
  'runs',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    /**
     * Null until the bible stage creates it. A run is started from a prompt
     * alone, and the series is its first output rather than its input.
     */
    seriesId: uuid('series_id').references(() => series.id, { onDelete: 'cascade' }),

    /** The one thing the user actually typed. */
    prompt: text('prompt').notNull(),
    /** How long the finished film should be. Drives the shot budget and estimate. */
    targetSeconds: integer('target_seconds').notNull().default(180),

    stage: runStage('stage').notNull().default('bible'),
    status: runStatus('status').notNull().default('pending'),

    /**
     * When the current gate stops waiting and continues on its own.
     *
     * Null whenever the run is not at a gate. This is what makes the gates
     * *skippable* rather than blocking: walk away and the film still gets made;
     * stay and you get a window to stop a wrong premise before it is baked into
     * thirty clips.
     */
    gateExpiresAt: timestamp('gate_expires_at', { withTimezone: true }),

    /** Quoted before the run starts, from the target length alone. */
    estimateCents: integer('estimate_cents').notNull().default(0),
    /** Summed from usage_log as stages complete. */
    spentCents: integer('spent_cents').notNull().default(0),

    error: text('error'),
    /** Per-stage results — counts, ids, diffs — for the progress view. */
    meta: jsonb('meta'),
    ...timestamps,
  },
  (t) => [
    index('runs_user_created_idx').on(t.userId, t.createdAt),
    index('runs_series_id_idx').on(t.seriesId),
    // The supervisor's "is anything waiting on me" scan.
    index('runs_status_idx').on(t.status),
    ownerPolicy('runs_owner_all', sql.raw(`runs.user_id = ${UID}`)),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* usage_log                                                                  */
/* -------------------------------------------------------------------------- */

export const usageLog = pgTable(
  'usage_log',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    seriesId: uuid('series_id').references(() => series.id, { onDelete: 'set null' }),
    episodeId: uuid('episode_id').references(() => episodes.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    costCents: integer('cost_cents').notNull().default(0),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /**
     * Makes a charge recordable exactly once.
     *
     * Inngest may re-run a step whose execution failed part-way, and this insert
     * used to be unconditional — so a restart mid-generation produced 21 ledger
     * rows for 20 clips (315¢ recorded against 300¢ of assets), breaking the
     * AC #5 invariant that the ledger matches `assets.cost_cents` exactly.
     *
     * Nullable on purpose: Postgres treats NULLs as distinct in a unique index,
     * so callers with nothing meaningful to key on (one-off LLM calls) are
     * unconstrained, while per-attempt provider charges are deduplicated.
     */
    idempotencyKey: text('idempotency_key'),
    ...timestamps,
  },
  (t) => [
    index('usage_log_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('usage_log_idempotency_key_idx').on(t.idempotencyKey),
    // Both are FKs with ON DELETE SET NULL, and the Phase 5 dashboard groups by
    // them.
    index('usage_log_series_id_idx').on(t.seriesId),
    index('usage_log_episode_id_idx').on(t.episodeId),
    ownerPolicy('usage_log_owner_all', sql.raw(`usage_log.user_id = ${UID}`)),
  ],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                         */
/* -------------------------------------------------------------------------- */

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type CharacterReferenceImage = typeof characterReferenceImages.$inferSelect;
export type NewCharacterReferenceImage = typeof characterReferenceImages.$inferInsert;
export type Episode = typeof episodes.$inferSelect;
export type NewEpisode = typeof episodes.$inferInsert;
export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;
export type Shot = typeof shots.$inferSelect;
export type NewShot = typeof shots.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type Render = typeof renders.$inferSelect;
export type NewRender = typeof renders.$inferInsert;
export type UsageLogRow = typeof usageLog.$inferSelect;
export type NewUsageLogRow = typeof usageLog.$inferInsert;
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStage = (typeof runStage.enumValues)[number];
export type RunStatus = (typeof runStatus.enumValues)[number];
