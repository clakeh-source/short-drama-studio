import 'server-only';

import { paymentRequired } from '@/lib/api/handler';
import type { LlmProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * The spend cap, applied to model calls.
 *
 * The video, TTS and render paths estimate a job's cost from the work in front
 * of them and refuse before anything is enqueued. Model calls had no equivalent:
 * they recorded what they spent afterwards, so the ledger was right and the cap
 * simply never fired. Every route below now asks the same question the
 * generation routes ask, before the first token.
 *
 * The estimate is the worst case for one attempt: the whole output budget, at
 * the provider's own rate. Real answers come in well under it, so this refuses
 * slightly early rather than slightly late — the right direction for a ceiling.
 * A corrective retry inside `streamJson` can still carry a generation past the
 * cap by one attempt, the same way a video job that is already running is not
 * cancelled mid-flight.
 */

/**
 * Output-token budget per operation. Imported by the callers rather than copied,
 * so the number the cap reasons about is the number the request actually sends.
 */
export const LLM_BUDGETS = {
  'safety.screen': 2_000,
  'export.caption': 8_000,
  'script.regenerate_scene': 8_000,
  'bible.generate': 24_000,
  'bible.derive': 24_000,
  'script.generate': 32_000,
  'storyboard.generate': 32_000,
} as const;

export type LlmOperation = keyof typeof LLM_BUDGETS;

/**
 * What one attempt at `operation` could cost, in cents.
 *
 * `promptChars` is the caller's input where it is already to hand and large
 * enough to matter — an imported screenplay, an episode script. Omit it for the
 * short prompts: output is priced several times higher than input and dominates
 * the total, so a few thousand characters of brief move the estimate by less
 * than a cent.
 */
export function estimateLlmCents(
  provider: LlmProvider,
  operation: LlmOperation,
  promptChars = 0,
): number {
  return provider.estimateCostCents({
    operation,
    system: '',
    messages: [{ role: 'user', content: ' '.repeat(promptChars) }],
    maxTokens: LLM_BUDGETS[operation],
  });
}

/**
 * Refuses with a 402 when this call would take the user past their monthly cap.
 *
 * Call it before the provider is touched. On the SSE routes that means the
 * `preflight` hook, which runs before the stream opens so the refusal is a real
 * HTTP status the client can branch on rather than an `error` frame inside a
 * 200.
 */
export async function assertLlmBudget(
  userId: string,
  provider: LlmProvider,
  operation: LlmOperation,
  promptChars = 0,
): Promise<void> {
  return assertLlmBudgetTotal(userId, provider, [{ operation, promptChars }]);
}

/**
 * The same guard for a request that makes several model calls before it
 * returns — importing a script screens it and then derives a bible from it.
 * Charging the cap for the first and discovering the second is unaffordable
 * halfway through would be the worst of both: money spent, nothing saved.
 */
export async function assertLlmBudgetTotal(
  userId: string,
  provider: LlmProvider,
  calls: Array<{ operation: LlmOperation; promptChars?: number }>,
): Promise<void> {
  const estimateCents = calls.reduce(
    (total, call) => total + estimateLlmCents(provider, call.operation, call.promptChars ?? 0),
    0,
  );

  const spend = await checkSpend(userId, estimateCents);

  if (!spend.allowed) {
    throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
  }
}
