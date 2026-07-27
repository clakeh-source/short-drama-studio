/**
 * The automatic-retry policy for provider failures.
 *
 * Extracted from the job functions so the rule is stated once and can be
 * asserted directly: a retryable failure is retried at most twice, and a
 * non-retryable one is never retried. Phase 3 AC #3 is exactly this table.
 */

/** Retries *after* the first attempt. Three provider calls in the worst case. */
export const MAX_AUTOMATIC_RETRIES = 2;

export function shouldRetry(retryable: boolean, attempt: number): boolean {
  if (!retryable) return false;
  return attempt < MAX_AUTOMATIC_RETRIES;
}

/** Total provider calls a shot can consume without human intervention. */
export function maxProviderCalls(): number {
  return MAX_AUTOMATIC_RETRIES + 1;
}
