import Anthropic from '@anthropic-ai/sdk';
import type { LlmGenerateInput, LlmProvider, LlmStreamChunk, LlmUsage } from '../types';

/**
 * The one file in the codebase allowed to import @anthropic-ai/sdk.
 *
 * Model is read from ANTHROPIC_MODEL (default claude-sonnet-4-6, per the build
 * spec). Note that claude-sonnet-4-6 does not support structured outputs, which
 * is why /lib/ai asks for JSON in the prompt and validates with Zod + one retry
 * rather than using output_config.format.
 */

/** USD per million tokens, by model. Used to turn token counts into cents. */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const FALLBACK_PRICING = { in: 3, out: 15 };

/** Rough characters-per-token for the pre-flight estimate only. */
const CHARS_PER_TOKEN = 3.6;

export function costCents(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICING[model] ?? FALLBACK_PRICING;
  const dollars = (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
  return Math.ceil(dollars * 100);
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly model: string;

  #client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Set it in .env.local, or set the provider to `stub` for local development.',
      );
    }

    this.model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-6';
    this.#client = new Anthropic({ apiKey });
  }

  estimateCostCents(input: LlmGenerateInput): number {
    const promptChars =
      input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0);
    const tokensIn = Math.ceil(promptChars / CHARS_PER_TOKEN);
    return costCents(this.model, tokensIn, input.maxTokens);
  }

  async *stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamChunk, LlmUsage, void> {
    const stream = this.#client.messages.stream({
      model: this.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      // Adaptive thinking is the supported mode on 4.6+; budget_tokens is
      // deprecated there. Effort tunes depth without a token budget.
      // `display: summarized` is what makes reasoning visible while the model
      // works — without it the stream is silent until the answer begins.
      thinking:
        input.thinking === 'off'
          ? { type: 'disabled' }
          : { type: 'adaptive', display: 'summarized' },
      output_config: { effort: input.effort ?? 'medium' },
    });

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', text: event.delta.thinking };
      }
    }

    const message = await stream.finalMessage();
    const tokensIn = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0);
    const tokensOut = message.usage.output_tokens;

    // `max_tokens` caps thinking *plus* answer text. When adaptive thinking
    // spends the budget the answer is cut off mid-sentence, and the caller sees
    // an unparseable fragment. Say what actually happened instead.
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `${input.operation}: the model hit its ${input.maxTokens}-token budget before finishing. ` +
          `Adaptive thinking is billed against max_tokens, so raise maxTokens or lower effort.`,
      );
    }

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `${input.operation}: the model declined this request` +
          (message.stop_details?.type === 'refusal' && message.stop_details.category
            ? ` (${message.stop_details.category}).`
            : '.'),
      );
    }

    return { tokensIn, tokensOut, costCents: costCents(this.model, tokensIn, tokensOut) };
  }
}
