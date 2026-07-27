'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Client half of the SSE protocol in lib/api/sse.ts.
 *
 * Exposes the raw streamed text so the UI can show tokens as they land, plus
 * the validated payload from the `done` event once the server has saved it.
 */

export type GenerationState = 'idle' | 'streaming' | 'done' | 'error';

export interface GenerationHandle<TDone> {
  state: GenerationState;
  /** The answer so far — the JSON the model is building. */
  text: string;
  /**
   * The model's reasoning so far. On a hard request this arrives long before
   * the first character of the answer, and it is what the UI shows meanwhile.
   */
  thinking: string;
  status: string;
  error: string | null;
  /** Milliseconds from request start to the first fragment of either kind. */
  firstTokenMs: number | null;
  result: TDone | null;
  run: (url: string, body?: unknown) => Promise<TDone | null>;
  reset: () => void;
}

interface SseFrame {
  event: string;
  data: unknown;
}

function parseFrames(chunk: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of chunk.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) continue;
    try {
      frames.push({ event, data: JSON.parse(data) });
    } catch {
      // A frame split across chunk boundaries; the caller re-buffers.
    }
  }
  return frames;
}

export function useGeneration<TDone = unknown>(): GenerationHandle<TDone> {
  const [state, setState] = useState<GenerationState>('idle');
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [result, setResult] = useState<TDone | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState('idle');
    setText('');
    setThinking('');
    setStatus('');
    setError(null);
    setFirstTokenMs(null);
    setResult(null);
  }, []);

  const run = useCallback(async (url: string, body?: unknown): Promise<TDone | null> => {
    /**
     * Refuse to start a second run while one is in flight.
     *
     * This used to abort the previous request and start again, which is wrong
     * for every caller here: each `run` is a paid model call lasting minutes,
     * so a double-fired click bought two of them and then threw the first away
     * mid-flight. Worse, the abort is what closed the server's stream, and the
     * server treated that as a fatal error rather than a departed reader — so
     * the surviving generation could still end up unsaved.
     *
     * `reset()` remains the explicit way to cancel and start over.
     */
    if (abortRef.current) return null;

    const controller = new AbortController();
    abortRef.current = controller;

    setState('streaming');
    setText('');
    setThinking('');
    setStatus('');
    setError(null);
    setFirstTokenMs(null);
    setResult(null);

    const startedAt = performance.now();
    let sawFirstToken = false;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done: TDone | null = null;

      while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;

        buffer += decoder.decode(value, { stream: true });

        // Keep the trailing partial frame in the buffer.
        const lastBreak = buffer.lastIndexOf('\n\n');
        if (lastBreak === -1) continue;
        const complete = buffer.slice(0, lastBreak + 2);
        buffer = buffer.slice(lastBreak + 2);

        for (const frame of parseFrames(complete)) {
          switch (frame.event) {
            case 'delta': {
              if (!sawFirstToken) {
                sawFirstToken = true;
                setFirstTokenMs(Math.round(performance.now() - startedAt));
              }
              const chunk = frame.data as { type?: 'thinking' | 'text'; text: string };
              if (chunk.type === 'thinking') {
                setThinking((prev) => prev + chunk.text);
              } else {
                setText((prev) => prev + chunk.text);
              }
              break;
            }
            case 'status':
              setStatus((frame.data as { message: string }).message);
              break;
            case 'done':
              done = frame.data as TDone;
              break;
            case 'error':
              throw new Error((frame.data as { message: string }).message);
          }
        }
      }

      if (!done) throw new Error('The stream ended before the result arrived.');

      setResult(done);
      setState('done');
      setStatus('');
      return done;
    } catch (err) {
      if (controller.signal.aborted) {
        setState('idle');
        return null;
      }
      setError(err instanceof Error ? err.message : 'Generation failed.');
      setState('error');
      return null;
    } finally {
      abortRef.current = null;
    }
  }, []);

  return { state, text, thinking, status, error, firstTokenMs, result, run, reset };
}
