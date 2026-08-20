import 'server-only';

import { z } from 'zod';
import type { LlmMessage, LlmProvider, LlmStreamChunk, LlmUsage } from '@/lib/providers';
import { ProviderRequestError, TokenBudgetError } from '@/lib/providers';
import { log } from '@/lib/log';

/**
 * Streamed JSON generation with schema validation and one corrective retry.
 *
 * claude-sonnet-4-6 does not support structured outputs, so the contract is
 * enforced here instead: ask for JSON, extract it, validate with Zod, and on
 * failure re-ask once with the validation error appended. That "retry once with
 * the validation error" loop is what Phase 1 AC #1 measures.
 */

/** Raised when output parses and validates structurally but is wrong in substance. */
class SemanticValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticValidationError';
  }
}

export class JsonGenerationError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastRaw: string,
    /**
     * Which kind of failure exhausted the attempts.
     *
     * `schema` means the model answered and the answer was wrong — there is raw
     * output to show the user. `provider` means it never answered at all: an
     * outage, a rate limit, an empty account. Callers must not conflate them.
     * Reporting "the model returned output that did not match the schema" when
     * the truth is "your Anthropic balance is zero" sends someone looking at
     * their prompt for an hour.
     */
    readonly kind: 'schema' | 'provider' = 'schema',
    /** The underlying provider message, when `kind` is `provider`. */
    readonly providerError?: string,
  ) {
    super(message);
    this.name = 'JsonGenerationError';
  }
}

/**
 * Pulls a JSON object out of model text. Tolerates ``` fences and any preamble
 * or trailing commentary, which is the realistic failure mode when a model is
 * asked for JSON-only.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in the response.');
  }

  return text.slice(start, end + 1);
}

export interface StreamJsonOptions<T> {
  provider: LlmProvider;
  /** Label for logs and usage_log rows. */
  operation: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /** Passed straight to the provider; see LlmGenerateInput.thinking. */
  thinking?: 'adaptive' | 'off';
  /**
   * Called with every fragment, for SSE passthrough. Receives reasoning as well
   * as answer text — the reasoning is what keeps the UI alive while a hard
   * request thinks, and only `text` is accumulated into the JSON.
   */
  onDelta?: (chunk: LlmStreamChunk) => void;
  /** Total attempts including the first. Defaults to 2 (one retry). */
  maxAttempts?: number;
  /**
   * Backoff before retrying a *provider* failure, multiplied by the attempt
   * number. Schema retries do not wait — nothing is rate-limiting them. Set to
   * 0 in tests.
   */
  retryDelayMs?: number;
  /**
   * Semantic validation the schema cannot express — "this script is 45 seconds
   * long and it needed to be 60". Return null to accept, or a message telling
   * the model what to change; a rejection re-enters the same retry loop as a
   * schema failure, so the model sees the measured numbers and can act on them.
   */
  validate?: (data: T) => string | null;
}

export interface StreamJsonResult<T> {
  data: T;
  /** Summed across every attempt — a retry is not free and must be logged. */
  usage: LlmUsage;
  attempts: number;
  raw: string;
}

export async function streamJson<T>(options: StreamJsonOptions<T>): Promise<StreamJsonResult<T>> {
  const maxAttempts = options.maxAttempts ?? 2;
  const messages: LlmMessage[] = [{ role: 'user', content: options.prompt }];

  const total: LlmUsage = { tokensIn: 0, tokensOut: 0, costCents: 0 };
  let lastError = '';
  let lastKind: 'schema' | 'provider' = 'schema';
  let raw = '';

  /**
   * Forced off for the rest of the run once the budget has been exhausted once.
   * `max_tokens` covers thinking as well as the answer, so an identical retry
   * burns the budget the same way; with thinking off the whole allowance goes to
   * the answer, which is the version that can actually finish.
   */
  let thinking = options.thinking;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    raw = '';

    try {
      /**
       * Consuming the stream belongs *inside* the retry, not before it.
       *
       * It used to sit outside this `try`, so anything the provider threw —
       * an overloaded API, a dropped connection, a budget exhausted by adaptive
       * thinking — escaped `streamJson` entirely and failed the whole
       * generation on the first attempt, no matter what `maxAttempts` said. The
       * retry budget only ever covered schema misses, which are the failure the
       * model is *least* likely to produce. The user saw "Generation failed",
       * nothing was saved, and because `recordUsage` runs after this returns,
       * the tokens already paid for were never even logged.
       */
      const generator = options.provider.stream({
        operation: options.operation,
        system: options.system,
        messages,
        maxTokens: options.maxTokens,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(thinking ? { thinking } : {}),
      });

      let usage: LlmUsage;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          usage = next.value;
          break;
        }
        if (next.value.type === 'text') raw += next.value.text;
        options.onDelta?.(next.value);
      }

      total.tokensIn += usage.tokensIn;
      total.tokensOut += usage.tokensOut;
      total.costCents += usage.costCents;

      const parsed = options.schema.parse(JSON.parse(extractJson(raw)));

      const complaint = options.validate?.(parsed);
      if (complaint) {
        // Last attempt: take it anyway. A slightly mistimed script the user can
        // edit beats no script at all.
        if (attempt === maxAttempts) {
          log.warn('accepting output that failed semantic validation', {
            operation: options.operation,
            attempt,
            error: complaint,
          });
          return { data: parsed, usage: total, attempts: attempt, raw };
        }
        throw new SemanticValidationError(complaint);
      }

      return { data: parsed, usage: total, attempts: attempt, raw };
    } catch (error) {
      const semantic = error instanceof SemanticValidationError;
      const budget = error instanceof TokenBudgetError;
      // Anything thrown by the provider rather than by parsing or validation.
      // There is no corrected JSON to ask for — the request never produced an
      // answer — so these retry the same request unchanged.
      const fromProvider = budget || error instanceof ProviderRequestError || !(
        semantic ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error && /No JSON object found/.test(error.message))
      );

      lastError =
        error instanceof z.ZodError
          ? JSON.stringify(z.treeifyError(error))
          : error instanceof Error
            ? error.message
            : String(error);

      lastKind = fromProvider ? 'provider' : 'schema';

      log.warn('json generation attempt failed', {
        operation: options.operation,
        attempt,
        provider: options.provider.id,
        kind: budget ? 'token_budget' : fromProvider ? 'provider' : 'schema',
        error: lastError.slice(0, 500),
      });

      // A refusal or a bad request is settled — the service will answer the
      // same way next time, and every attempt is billed.
      if (error instanceof ProviderRequestError && !error.retryable) throw error;

      if (attempt === maxAttempts) break;

      if (budget) thinking = 'off';

      if (fromProvider) {
        // Nothing to correct, and the conversation must stay as it was: a
        // truncated assistant turn would poison every later attempt.
        if (options.retryDelayMs !== 0) {
          await new Promise((r) => setTimeout(r, (options.retryDelayMs ?? 500) * attempt));
        }
        continue;
      }

      // Feed the failure back. An assistant turn mid-conversation is fine —
      // only a trailing assistant prefill is rejected on 4.6+.
      messages.push({ role: 'assistant', content: raw.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: semantic
          ? `${lastError}\n\nReturn the corrected JSON object only. No prose, no code fences.`
          : 'That response did not satisfy the schema. Validation errors:\n' +
            `${lastError}\n\n` +
            'Return the corrected JSON object only. No prose, no code fences.',
      });
    }
  }

  throw new JsonGenerationError(
    lastKind === 'provider'
      ? `${options.operation} could not reach the model after ${maxAttempts} attempts: ${lastError}`
      : `${options.operation} failed schema validation after ${maxAttempts} attempts: ${lastError}`,
    maxAttempts,
    raw,
    lastKind,
    ...(lastKind === 'provider' ? ([lastError] as const) : []),
  );
}
