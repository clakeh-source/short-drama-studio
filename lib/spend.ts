import 'server-only';

import { env } from '@/lib/env';
import { getMonthlySpendCents } from '@/lib/usage';

/**
 * The hard spend ceiling.
 *
 * Checked before anything is enqueued, not before each job — Phase 3 AC #6
 * requires that exceeding the cap enqueues *nothing*, so a 12-shot episode
 * either goes in whole or not at all. Individual jobs re-check on the way
 * through, because a concurrent episode can move the number underneath them.
 */

export class SpendCapError extends Error {
  constructor(
    readonly spentCents: number,
    readonly capCents: number,
    readonly requestedCents: number,
  ) {
    super(
      `This would cost about ${fmt(requestedCents)} on top of ${fmt(spentCents)} already spent ` +
        `this month, which is over your ${fmt(capCents)} cap. Nothing was queued. ` +
        `Raise MAX_MONTHLY_SPEND_CENTS or wait for the month to roll over.`,
    );
    this.name = 'SpendCapError';
  }
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface SpendCheck {
  allowed: boolean;
  spentCents: number;
  capCents: number;
  requestedCents: number;
  remainingCents: number;
  message?: string;
}

/** Non-throwing form, for showing the user where they stand before they commit. */
export async function checkSpend(userId: string, requestedCents: number): Promise<SpendCheck> {
  const capCents = env().MAX_MONTHLY_SPEND_CENTS;
  const spentCents = await getMonthlySpendCents(userId);
  const remainingCents = Math.max(0, capCents - spentCents);
  const allowed = spentCents + requestedCents <= capCents;

  return {
    allowed,
    spentCents,
    capCents,
    requestedCents,
    remainingCents,
    ...(allowed ? {} : { message: new SpendCapError(spentCents, capCents, requestedCents).message }),
  };
}

/** Throwing form, for the enqueue path. */
export async function assertWithinSpendCap(
  userId: string,
  requestedCents: number,
): Promise<SpendCheck> {
  const check = await checkSpend(userId, requestedCents);
  if (!check.allowed) {
    throw new SpendCapError(check.spentCents, check.capCents, check.requestedCents);
  }
  return check;
}
