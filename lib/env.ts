import 'server-only';
import { z } from 'zod';

/**
 * Server-side environment. Validated lazily (on first access) rather than at
 * import time, so `next build` never needs real credentials — only running the
 * app does. Client components must not import this module; the ESLint config
 * forbids it.
 */

const serverEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),

  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  SUPABASE_BUCKET_CLIPS: z.string().min(1).default('clips'),
  SUPABASE_BUCKET_AUDIO: z.string().min(1).default('audio'),
  SUPABASE_BUCKET_RENDERS: z.string().min(1).default('renders'),
  // Character reference stills. Unlike the other three this bucket holds user
  // *input* rather than generated output, and it is the only one a browser
  // writes to directly (presigned upload, Phase 2).
  SUPABASE_BUCKET_REFERENCES: z.string().min(1).default('references'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),

  LLM_PROVIDER: z.string().optional(),
  VIDEO_PROVIDER: z.string().min(1).default('stub'),
  TTS_PROVIDER: z.string().min(1).default('stub'),
  RENDER_PROVIDER: z.string().min(1).default('stub'),

  REPLICATE_API_TOKEN: z.string().optional(),
  REPLICATE_VIDEO_MODEL: z.string().optional(),
  // The model's own shape, not Replicate's: which clip lengths it accepts, what
  // it charges per second of output, and any inputs outside VideoGenInput.
  REPLICATE_VIDEO_DURATIONS: z.string().optional(),
  REPLICATE_VIDEO_COST_CENTS_PER_SECOND: z.coerce.number().nonnegative().optional(),
  REPLICATE_VIDEO_IMAGE_INPUT: z.string().optional(),
  REPLICATE_VIDEO_EXTRA_INPUT: z.string().optional(),

  // fal.ai hosts Kling. Both model ids are fixed rather than free-form because
  // the adapter (Phase 4) chooses between them on one rule — image-to-video when
  // the shot's characters have canonical reference stills, text-to-video when
  // they do not — and the two endpoints take different inputs.
  FAL_KEY: z.string().optional(),
  FAL_KLING_TEXT_TO_VIDEO_MODEL: z
    .string()
    .min(1)
    .default('fal-ai/kling-video/v3/pro/text-to-video'),
  FAL_KLING_IMAGE_TO_VIDEO_MODEL: z
    .string()
    .min(1)
    .default('fal-ai/kling-video/v3/pro/image-to-video'),
  FAL_KLING_COST_CENTS_PER_SECOND: z.coerce.number().nonnegative().optional(),
  // Text-to-image, used for character reference stills.
  FAL_IMAGE_MODEL: z.string().min(1).default('fal-ai/flux/dev'),
  FAL_IMAGE_COST_CENTS: z.coerce.number().nonnegative().optional(),
  // Identity-preserving model: takes the face from a reference still and
  // everything else from the prompt, so a character's set is one person.
  FAL_IMAGE_IDENTITY_MODEL: z.string().min(1).default('fal-ai/flux-pulid'),
  FAL_IMAGE_IDENTITY_COST_CENTS: z.coerce.number().nonnegative().optional(),
  FAL_KLING_EXTRA_INPUT: z.string().optional(),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),
  // WAV keeps the `audio/wav` upload in generate-shot-voice honest; 24kHz keeps
  // it off the Pro-only formats.
  ELEVENLABS_OUTPUT_FORMAT: z.string().default('wav_24000'),
  ELEVENLABS_CENTS_PER_1K_CHARS: z.coerce.number().nonnegative().optional(),
  SHOTSTACK_API_KEY: z.string().optional(),
  SHOTSTACK_ENV: z.enum(['stage', 'v1']).default('stage'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  // How far the optional music bed sits under the dialogue, in dB. Negative.
  MUSIC_BED_LEVEL_DB: z.coerce.number().max(0).optional(),
  /**
   * In-flight video jobs per project. The biggest lever on how long a
   * multi-minute run takes; 3 is the safe default. See MAX_INFLIGHT_VIDEO_JOBS.
   */
  VIDEO_CONCURRENCY: z.coerce.number().int().min(1).max(24).optional(),
  /** Seconds a run waits at a gate before continuing on its own. */
  RUN_GATE_SECONDS: z.coerce.number().int().nonnegative().optional(),

  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  // Where /api/health probes for the local Inngest dev server. Ignored once
  // INNGEST_EVENT_KEY is set, which means the app is talking to Inngest Cloud.
  INNGEST_DEV_URL: z.url().default('http://127.0.0.1:8288'),

  MAX_MONTHLY_SPEND_CENTS: z.coerce.number().int().positive().default(2000),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid or missing environment variables:\n${missing}\n\nCopy .env.example to .env.local and fill it in.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: drop the memoised env so a test can mutate process.env. */
export function resetEnvCache(): void {
  cached = null;
}
