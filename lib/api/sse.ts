import 'server-only';

import type { User } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireApiUser, UnauthorizedError } from '@/lib/auth';
import { log } from '@/lib/log';
import { ApiError } from './handler';

/**
 * Server-sent-events wrapper for the generation routes.
 *
 * Every AI call streams to the UI (Phase 1 AC #6), so these routes cannot use
 * the JSON `route()` helper. They get the same guarantees — session required,
 * Zod on the body, structured logging, a uniform error shape — but deliver
 * results as an event stream instead of one response body.
 *
 * Event protocol:
 *   delta  { text }     incremental model output, for live display
 *   status { message }  human-readable progress ("validating", "saving")
 *   done   { ...  }     the final validated payload
 *   error  { message }  terminal failure; the stream closes after it
 */

export type SseSend = (event: 'delta' | 'status' | 'done' | 'error', data: unknown) => void;

interface SseRouteConfig<TBody> {
  operation: string;
  body?: z.ZodType<TBody>;
}

interface SseContext<TBody, TParams> {
  body: TBody;
  params: TParams;
  user: User;
  request: Request;
  send: SseSend;
  idempotencyKey: string | null;
}

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sseRoute<
  TParams extends Record<string, string | string[]>,
  TBody = undefined,
>(
  config: SseRouteConfig<TBody>,
  handler: (ctx: SseContext<TBody, TParams>) => Promise<void>,
) {
  return async (request: Request, context: { params: Promise<TParams> }): Promise<Response> => {
    const start = Date.now();

    // Auth and body validation happen before the stream opens, so failures
    // surface as a normal HTTP status the client can branch on.
    let user: User;
    try {
      user = await requireApiUser();
    } catch (error) {
      const status = error instanceof UnauthorizedError ? 401 : 500;
      return Response.json(
        { error: { code: 'unauthorized', message: 'Not signed in' } },
        { status },
      );
    }

    let body = undefined as TBody;
    if (config.body) {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json(
          { error: { code: 'bad_request', message: 'Request body must be valid JSON' } },
          { status: 400 },
        );
      }
      const parsed = config.body.safeParse(raw);
      if (!parsed.success) {
        return Response.json(
          {
            error: {
              code: 'bad_request',
              message: 'Invalid request body',
              details: z.treeifyError(parsed.error),
            },
          },
          { status: 400 },
        );
      }
      body = parsed.data;
    }

    const params = await context.params;

    /**
     * Set when the browser goes away — a closed tab, a navigation, or a second
     * request superseding this one. Declared out here because it is written by
     * `cancel()` below and read by `send` inside `start()`.
     */
    let clientGone = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;

        /**
         * Never throws.
         *
         * The obvious version — `controller.enqueue(...)` guarded by a local
         * flag — cannot work, because the flag only knows about closes *we*
         * perform. When the client disconnects, the controller is closed
         * underneath us and `enqueue` throws `Invalid state: Controller is
         * already closed`. That throw surfaced inside `onDelta`, deep in the
         * generation call, and tore down the whole handler *before* it reached
         * its `persist…` step: three minutes of Anthropic output, paid for and
         * discarded, with the episode still showing "No script yet".
         *
         * A client that has hung up is not an error. There is simply nobody
         * left to send to, so stop sending and let the work finish and save.
         */
        const send: SseSend = (event, data) => {
          if (closed || clientGone) return;
          try {
            controller.enqueue(frame(event, data));
          } catch {
            clientGone = true;
          }
        };

        try {
          await handler({
            body,
            params,
            user,
            request,
            send,
            idempotencyKey: request.headers.get('idempotency-key'),
          });

          log.info(`${config.operation} ok`, {
            operation: config.operation,
            userId: user.id,
            durationMs: Date.now() - start,
          });
        } catch (error) {
          const message =
            error instanceof ApiError
              ? error.message
              : 'Generation failed. Nothing was saved — you can try again.';

          log.error(`${config.operation} failed`, {
            operation: config.operation,
            userId: user.id,
            durationMs: Date.now() - start,
            error: error instanceof Error ? error.message : String(error),
          });

          send('error', { message });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by the client's own disconnect. Nothing to do.
          }
        }
      },

      /**
       * The client hung up. Record it so `send` stops trying, but do not abort
       * the handler: the model output is already bought, and the point of
       * finishing is that it gets persisted rather than thrown away. Reloading
       * the page then shows the finished script.
       */
      cancel() {
        clientGone = true;
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer streamed responses without this.
        'x-accel-buffering': 'no',
      },
    });
  };
}
