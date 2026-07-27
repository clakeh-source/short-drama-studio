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

/* -------------------------------------------------------------------------- */
/* Language model                                                             */
/* -------------------------------------------------------------------------- */

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
  /** For character consistency, where the provider supports it. */
  referenceImageUrl?: string;
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
