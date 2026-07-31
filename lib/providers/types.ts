/**
 * The provider boundary.
 *
 * These interfaces are the ONLY way the rest of the application talks to an
 * external generation service. No provider SDK may be imported outside
 * /lib/providers — enforced by the `no-restricted-imports` rule in
 * eslint.config.mjs. Adding a provider means adding a file here plus one line
 * in registry.ts, and nothing else anywhere.
 *
 * This file has no imports on purpose: it must stay dependency-free so both
 * server code and unit tests can pull it in cheaply.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A provider refused a request outright, with a verdict on whether trying again
 * could ever help.
 *
 * `ProviderResult` already carries `retryable` for work that was *accepted* and
 * then failed. Submission had no equivalent: an adapter could only throw, and a
 * throw inside an Inngest step is retried by policy. So an empty Replicate
 * account (HTTP 402) or a revoked key (401) burned all four attempts before
 * failing, each one guaranteed to fail identically — found by pointing the
 * adapter at a real account with no credit on it.
 *
 * Adapters throw this instead of a bare Error; the jobs in /lib/inngest read
 * `retryable` rather than assuming.
 */
export class ProviderRequestError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'ProviderRequestError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/**
 * Whether an HTTP status is worth another attempt.
 *
 * Rate limits and server faults pass; everything else in the 4xx range is a
 * request the service will refuse again — bad credentials, no credit, a model
 * that does not exist, inputs it will not accept.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * A setting is missing or malformed.
 *
 * Adapters used to throw a bare `Error` for these, which made a typo in
 * `.env` indistinguishable from a network blip: the job in
 * /lib/inngest/functions/generate-shot-video.ts only short-circuits on a
 * non-retryable `ProviderRequestError`, so an unset `REPLICATE_VIDEO_MODEL`
 * spent four attempts per shot — 48 across a twelve-shot episode — to arrive at
 * the same certain failure, and left the assets mid-flight instead of failed
 * with the reason on them.
 *
 * No amount of retrying will set an environment variable, so these are always
 * `retryable: false`.
 */
export function configurationError(message: string): ProviderRequestError {
  return new ProviderRequestError(message, { retryable: false });
}

/* -------------------------------------------------------------------------- */
/* Language model                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The model spent its whole `max_tokens` budget before finishing the answer.
 *
 * Typed rather than a bare Error because the caller's response is specific: the
 * budget covers thinking *plus* answer text, so the retry that has a chance of
 * working is one with thinking turned off, not another identical attempt.
 */
export class TokenBudgetError extends Error {
  constructor(
    readonly operation: string,
    readonly maxTokens: number,
  ) {
    super(
      `${operation}: the model hit its ${maxTokens}-token budget before finishing. ` +
        `Adaptive thinking is billed against max_tokens, so raise maxTokens or lower effort.`,
    );
    this.name = 'TokenBudgetError';
  }
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateInput {
  /** Stable label for logs, usage_log rows, and stub fixture routing. */
  operation: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** Thinking depth. Maps to the provider's own knob where one exists. */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Whether the model should reason before answering.
   *
   * `off` for tasks where the prompt already specifies the answer's shape and
   * deliberation buys nothing — filling in a schema from a detailed brief. The
   * difference is not marginal: with thinking on, a single episode script took
   * **16 minutes**, because `max_tokens` has to cover thinking as well as the
   * answer and adaptive thinking expands to fill whatever it is given.
   */
  thinking?: 'adaptive' | 'off';
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

/**
 * A streamed fragment.
 *
 * `thinking` and `text` are separated deliberately. With adaptive thinking on,
 * a hard request can reason for a minute or more before the first character of
 * the answer — if the stream only carried `text`, the UI would sit blank for
 * that whole window. Callers show `thinking` as live progress and accumulate
 * only `text` as the answer.
 */
export interface LlmStreamChunk {
  type: 'thinking' | 'text';
  text: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /** Rough pre-flight estimate, used only for the cost panel. */
  estimateCostCents(input: LlmGenerateInput): number;
  /**
   * Yields fragments as they arrive and returns real token usage when the
   * message completes. Everything in /lib/ai streams — Phase 1 AC #6 requires
   * something on screen within 500ms, so there is no non-streaming variant.
   */
  stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamChunk, LlmUsage, void>;
}

/* -------------------------------------------------------------------------- */
/* Video                                                                      */
/* -------------------------------------------------------------------------- */

export interface VideoGenInput {
  prompt: string;
  negativePrompt?: string;
  /** Clamp to the provider's supported values inside the adapter. */
  durationSeconds: number;
  aspectRatio: '9:16';
  seed?: number;
  /**
   * Stills of the characters in this shot, for character consistency.
   *
   * An ordered set rather than one image: a shot can hold two people, and each
   * of them contributes their canonical reference set. Order is meaningful —
   * the first entry is the one an adapter sends when its model conditions on a
   * single image, so callers put the most important character first.
   *
   * Present and non-empty is what makes a call image-to-video; empty or absent
   * is text-to-video. Adapters must not invent a reference from the prompt.
   */
  referenceImageUrls?: string[];
}

export interface VideoProvider {
  readonly id: string;
  /**
   * Nearest duration this provider will actually render. Hosted video models
   * only accept a handful of values, so the storyboard has to plan against the
   * real grid rather than discovering it at generation time.
   */
  clampDuration(seconds: number): number;
  estimateCostCents(input: VideoGenInput): number;
  generate(input: VideoGenInput): Promise<{ providerJobId: string }>;
  poll(providerJobId: string): Promise<ProviderResult>;
}

/* -------------------------------------------------------------------------- */
/* Image                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImageGenInput {
  prompt: string;
  negativePrompt?: string;
  /** How many images to produce from this one prompt. */
  count: number;
  /**
   * Vertical by default, matching the video frame.
   *
   * A reference still that is landscape while every clip is 9:16 teaches the
   * video model the wrong framing for the character.
   */
  aspectRatio: '9:16' | '1:1';
  /**
   * Fixed across a character's stills so they read as the same person.
   *
   * The weak form of identity. A diffusion model given one seed and three
   * framing instructions produces three *related* images, not three photographs
   * of one person — it is the cheapest thing that helps, and it is what you get
   * when the provider cannot do better.
   */
  seed?: number;

  /**
   * A photograph the generated image must look like the same person as.
   *
   * The strong form. Presence switches the adapter to an identity-preserving
   * model, which takes the face from this image and the pose, framing and
   * setting from the prompt. That is the difference between a canonical set
   * that is one character and one that is three cousins.
   *
   * Must be a URL the provider can fetch — these models pull the reference
   * themselves, so a signed URL needs to outlive the queue wait.
   *
   * Ignored by providers whose `supportsIdentity` is false. Callers check that
   * rather than assuming, because silently dropping it would produce exactly
   * the drift this field exists to remove, with no sign anything was wrong.
   */
  identityImageUrl?: string;
}

export interface GeneratedImage {
  url: string;
  contentType: string;
}

export interface ImageProvider {
  readonly id: string;
  /**
   * Whether `identityImageUrl` does anything here.
   *
   * Declared rather than inferred so a caller can *degrade deliberately* — fall
   * back to a shared seed and record that the set is not identity-locked —
   * instead of passing a reference into a model that ignores it and getting
   * drift it has no way to detect.
   */
  readonly supportsIdentity: boolean;
  estimateCostCents(input: ImageGenInput): number;
  /**
   * Synchronous from the caller's point of view.
   *
   * Unlike video, image generation is seconds rather than minutes, so there is
   * no durable submit/poll split to justify: a job that finishes inside one
   * request does not need to survive a restart.
   */
  generate(input: ImageGenInput): Promise<{ images: GeneratedImage[]; costCents: number }>;
}

/**
 * Per-word timing, when the provider reports it.
 *
 * Optional because not every TTS service returns alignment data. Captions fall
 * back to distributing the measured clip duration across the words in
 * proportion to their length, which is close enough at caption granularity —
 * but real timings are always better, so the field exists for the providers
 * that have them.
 */
export interface TtsWordTiming {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TtsResult {
  audio: Buffer;
  /** Measured, never rounded to fit the shot it belongs to. */
  durationSeconds: number;
  words?: TtsWordTiming[];
}

export interface TtsProvider {
  readonly id: string;
  estimateCostCents(text: string): number;
  synthesize(input: { text: string; voiceId: string }): Promise<TtsResult>;
  listVoices(): Promise<Array<{ id: string; name: string; tags: string[] }>>;
}

export interface RenderInput {
  clips: Array<{ url: string; durationSeconds: number; startAt: number }>;
  voiceTracks: Array<{ url: string; startAt: number }>;
  musicUrl?: string;
  captions: Array<{ text: string; startAt: number; endAt: number }>;
  aspectRatio: '9:16';
  resolution: '1080x1920';
}

export interface RenderProvider {
  readonly id: string;
  estimateCostCents(input: RenderInput): number;
  render(input: RenderInput): Promise<{ providerJobId: string }>;
  poll(providerJobId: string): Promise<ProviderResult>;
}

export type ProviderResult =
  | { status: 'pending' }
  | { status: 'ready'; url: string; costCents: number; meta?: Record<string, unknown> }
  | { status: 'failed'; error: string; retryable: boolean };
