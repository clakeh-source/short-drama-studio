import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, LlmStreamChunk, LlmUsage } from '@/lib/providers';
import type { SpendCheck } from '@/lib/spend';

/**
 * The spend cap applied to model calls.
 *
 * The gap this file pins: the cap was checked on the video, TTS and render
 * routes and on none of the seven routes that spend model tokens. Those routes
 * recorded their spend afterwards, so the ledger was correct and the ceiling
 * simply never fired — a signed-in user could hold spend at any multiple of the
 * cap by looping "regenerate script" while the video routes kept refusing.
 */

const spent = { cents: 0 };
const CAP = 2_000;

vi.mock('@/lib/spend', () => ({
  checkSpend: vi.fn(
    async (_userId: string, requestedCents: number): Promise<SpendCheck> => ({
      allowed: spent.cents + requestedCents <= CAP,
      spentCents: spent.cents,
      capCents: CAP,
      requestedCents,
      remainingCents: Math.max(0, CAP - spent.cents),
      ...(spent.cents + requestedCents <= CAP ? {} : { message: 'over the cap' }),
    }),
  ),
}));

const { assertLlmBudget, assertLlmBudgetTotal, estimateLlmCents, LLM_BUDGETS } = await import(
  '@/lib/ai/budget'
);
const { checkSpend } = await import('@/lib/spend');
const { ApiError } = await import('@/lib/api/handler');

/** Prices output at a cent per thousand tokens and input at a tenth of that. */
const provider: LlmProvider = {
  id: 'test',
  model: 'test-model',
  // Never reached: every test here refuses or allows before the call is made.
  async *stream(): AsyncGenerator<LlmStreamChunk, LlmUsage, void> {
    throw new Error('the budget guard must run before the provider is touched');
  },
  estimateCostCents: (input) => {
    const promptChars = input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0);
    return Math.ceil(input.maxTokens / 1_000) + Math.ceil(promptChars / 4 / 10_000);
  },
};

beforeEach(() => {
  spent.cents = 0;
  vi.clearAllMocks();
});

describe('estimateLlmCents', () => {
  it('prices an operation from its own output budget', () => {
    expect(estimateLlmCents(provider, 'script.generate')).toBe(
      Math.ceil(LLM_BUDGETS['script.generate'] / 1_000),
    );
  });

  it('costs more for a bigger budget', () => {
    // A whole script is a bigger commitment than one scene, and the estimate
    // has to say so or the cap refuses the cheap operations first.
    expect(estimateLlmCents(provider, 'script.generate')).toBeGreaterThan(
      estimateLlmCents(provider, 'script.regenerate_scene'),
    );
    expect(estimateLlmCents(provider, 'script.regenerate_scene')).toBeGreaterThan(
      estimateLlmCents(provider, 'safety.screen'),
    );
  });

  it('counts the caller-supplied prompt', () => {
    expect(estimateLlmCents(provider, 'bible.derive', 400_000)).toBeGreaterThan(
      estimateLlmCents(provider, 'bible.derive'),
    );
  });

  it('covers every operation that reaches a model', () => {
    // A new AI module that forgets to register here has no cap. The type stops
    // that at compile time; this stops the table being quietly emptied.
    for (const operation of Object.keys(LLM_BUDGETS)) {
      expect(LLM_BUDGETS[operation as keyof typeof LLM_BUDGETS]).toBeGreaterThan(0);
    }
  });
});

describe('assertLlmBudget', () => {
  it('lets a call through with room left', async () => {
    spent.cents = 100;
    await expect(assertLlmBudget('user-1', provider, 'bible.generate')).resolves.toBeUndefined();
  });

  it('refuses with a 402 once the cap is reached', async () => {
    spent.cents = CAP;

    const error = await assertLlmBudget('user-1', provider, 'export.caption').catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(402);
    expect((error as InstanceType<typeof ApiError>).code).toBe('spend_cap_exceeded');
  });

  it('refuses the expensive operation while the cheap one still fits', async () => {
    spent.cents = CAP - 5;

    await expect(assertLlmBudget('user-1', provider, 'safety.screen')).resolves.toBeUndefined();
    await expect(assertLlmBudget('user-1', provider, 'storyboard.generate')).rejects.toThrow();
  });
});

describe('assertLlmBudgetTotal', () => {
  it('charges the cap for every call the request will make', async () => {
    await assertLlmBudgetTotal('user-1', provider, [
      { operation: 'safety.screen' },
      { operation: 'bible.derive' },
    ]);

    // The import route screens *and* derives. Checking only the first would let
    // a user pay for a verdict on a script that then cannot be imported.
    expect(checkSpend).toHaveBeenCalledWith(
      'user-1',
      estimateLlmCents(provider, 'safety.screen') + estimateLlmCents(provider, 'bible.derive'),
    );
  });

  it('refuses when the pair exceeds the cap even though each half fits', async () => {
    spent.cents = CAP - estimateLlmCents(provider, 'bible.derive') - 1;

    await expect(
      assertLlmBudgetTotal('user-1', provider, [
        { operation: 'safety.screen' },
        { operation: 'bible.derive' },
      ]),
    ).rejects.toThrow();
  });
});
