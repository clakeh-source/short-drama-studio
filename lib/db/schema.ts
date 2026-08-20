import { sql } from 'drizzle-orm';
import {
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
    script: jsonb('script'),
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
    imagePrompt: text('image_prompt'),
    videoPrompt: text('video_prompt'),
    negativePrompt: text('negative_prompt'),
    /** User edit of video_prompt. Survives storyboard regeneration (Phase 2). */
    promptOverride: text('prompt_override'),
    status: shotStatus('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
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
/* rate_limits                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fixed-window request counters, one row per user per operation per window.
 *
 * Server-side state rather than in-memory, because the app runs as serverless
 * functions: an in-process counter would be per-instance, which is to say per
 * concurrent request under exactly the load a limiter exists for.
 *
 * RLS is on with no policy at all, which denies `authenticated` everything.
 * That is deliberate — nothing user-facing reads or writes this; it is touched
 * only through the privileged handle, the way the job tables are.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    /** `{userId}:{operation}:{windowStartEpochSeconds}` — built by lib/rate-limit.ts. */
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    /** Start of the window this row counts, and what the sweeper prunes on. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limits_window_start_idx').on(t.windowStart)],
).enableRLS();

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                         */
/* -------------------------------------------------------------------------- */

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
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
export type RateLimitRow = typeof rateLimits.$inferSelect;
