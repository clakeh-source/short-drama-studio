import 'server-only';

import { z } from 'zod';
import type { LlmMessage, LlmProvider, LlmStreamChunk, LlmUsage } from '@/lib/providers';
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
  let raw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    raw = '';

    const generator = options.provider.stream({
      operation: options.operation,
      system: options.system,
      messages,
      maxTokens: options.maxTokens,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
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

    try {
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
      lastError =
        error instanceof z.ZodError
          ? JSON.stringify(z.treeifyError(error))
          : error instanceof Error
            ? error.message
            : String(error);

      log.warn('json generation attempt failed', {
        operation: options.operation,
        attempt,
        provider: options.provider.id,
        error: lastError.slice(0, 500),
      });

      if (attempt === maxAttempts) break;

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
    `${options.operation} failed schema validation after ${maxAttempts} attempts: ${lastError}`,
    maxAttempts,
    raw,
  );
}
