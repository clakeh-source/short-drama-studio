import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractJson, JsonGenerationError, streamJson } from '@/lib/ai/json';
import type { LlmGenerateInput, LlmProvider, LlmStreamChunk, LlmUsage } from '@/lib/providers';

/** A provider that replays a scripted list of responses, one per attempt. */
function scriptedProvider(responses: string[]): LlmProvider & { calls: LlmGenerateInput[] } {
  const calls: LlmGenerateInput[] = [];
  let index = 0;

  return {
    id: 'scripted',
    model: 'scripted-v1',
    calls,
    estimateCostCents: () => 1,
    async *stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamChunk, LlmUsage, void> {
      calls.push(input);
      const body = responses[Math.min(index, responses.length - 1)] ?? '';
      index += 1;
      // Emit in two pieces so the delta path is genuinely exercised.
      yield { type: 'text', text: body.slice(0, Math.ceil(body.length / 2)) };
      yield { type: 'text', text: body.slice(Math.ceil(body.length / 2)) };
      return { tokensIn: 100, tokensOut: 50, costCents: 2 };
    },
  };
}

const schema = z.object({ name: z.string(), count: z.int() });

describe('extractJson', () => {
  it('takes a bare object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('ignores prose either side', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('keeps nested braces intact', () => {
    expect(extractJson('x {"a":{"b":[1,2]}} y')).toBe('{"a":{"b":[1,2]}}');
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON object/);
  });
});

describe('streamJson', () => {
  const base = {
    operation: 'test.op',
    system: 'system',
    prompt: 'prompt',
    schema,
    maxTokens: 100,
  };

  it('returns validated data on the first attempt', async () => {
    const provider = scriptedProvider(['{"name":"a","count":1}']);
    const result = await streamJson({ ...base, provider });

    expect(result.data).toEqual({ name: 'a', count: 1 });
    expect(result.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('streams every delta to onDelta', async () => {
    const provider = scriptedProvider(['{"name":"a","count":1}']);
    const onDelta = vi.fn();
    await streamJson({ ...base, provider, onDelta });

    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDelta.mock.calls.map((c) => c[0].text).join('')).toBe('{"name":"a","count":1}');
  });

  it('retries once with the validation error appended, then succeeds', async () => {
    const provider = scriptedProvider([
      '{"name":"a","count":"not a number"}',
      '{"name":"a","count":7}',
    ]);
    const result = await streamJson({ ...base, provider });

    expect(result.data).toEqual({ name: 'a', count: 7 });
    expect(result.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);

    // The retry carries the original prompt, the failed output, and the errors.
    const retry = provider.calls[1]!;
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1]?.role).toBe('assistant');
    expect(retry.messages[2]?.content).toMatch(/did not satisfy the schema/);
    expect(retry.messages[2]?.content).toMatch(/count/);
  });

  it('recovers from unparseable output, not just schema misses', async () => {
    const provider = scriptedProvider(['I would rather explain it in prose.', '{"name":"b","count":2}']);
    const result = await streamJson({ ...base, provider });
    expect(result.data).toEqual({ name: 'b', count: 2 });
    expect(result.attempts).toBe(2);
  });

  it('sums usage across attempts so a retry is not billed as free', async () => {
    const provider = scriptedProvider(['{"bad":true}', '{"name":"a","count":1}']);
    const result = await streamJson({ ...base, provider });

    expect(result.usage).toEqual({ tokensIn: 200, tokensOut: 100, costCents: 4 });
  });

  it('gives up after the attempt budget and reports why', async () => {
    const provider = scriptedProvider(['{"bad":true}']);
    await expect(streamJson({ ...base, provider })).rejects.toThrow(JsonGenerationError);
    expect(provider.calls).toHaveLength(2);
  });

  it('honours a custom attempt budget', async () => {
    const provider = scriptedProvider(['{"bad":true}']);
    await expect(streamJson({ ...base, provider, maxAttempts: 3 })).rejects.toThrow();
    expect(provider.calls).toHaveLength(3);
  });
});
