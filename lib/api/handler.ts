import 'server-only';

import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireApiUser, UnauthorizedError } from '@/lib/auth';
import { log } from '@/lib/log';

/** Uniform error envelope. Clients only ever have to parse this shape. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const paymentRequired = (message: string) =>
  new ApiError(402, 'spend_cap_exceeded', message);

interface RouteConfig<TBody, TQuery> {
  /** Zod schema for the JSON body. Omit for GET/DELETE. */
  body?: z.ZodType<TBody>;
  /** Zod schema for search params. */
  query?: z.ZodType<TQuery>;
  /** Set false for public routes; defaults to requiring a session. */
  auth?: boolean;
  /** Label used in structured logs. */
  operation: string;
}

interface RouteContext<TBody, TQuery, TParams> {
  body: TBody;
  query: TQuery;
  user: User;
  request: Request;
  params: TParams;
  /** Header-supplied idempotency key, if the caller sent one. */
  idempotencyKey: string | null;
}

/**
 * Wraps a route handler with Zod validation on every input, session checking,
 * structured logging and error-envelope mapping. Every route handler in the app
 * is built with this — that is how "Zod parse on every route handler input" is
 * enforced rather than merely encouraged.
 *
 * `route` is for static paths; `dynamicRoute` is the same thing for paths with
 * segments like `[id]`. They are separate exports because Next 15 type-checks
 * the exact arity and parameter type of every route export.
 */
export function route<TBody = undefined, TQuery = undefined, TResult = unknown>(
  config: RouteConfig<TBody, TQuery>,
  handler: (ctx: RouteContext<TBody, TQuery, Record<string, never>>) => Promise<TResult>,
) {
  const run = makeRunner<TBody, TQuery, Record<string, never>, TResult>(config, handler);
  return (request: Request): Promise<Response> =>
    run(request, {} as Record<string, never>);
}

export function dynamicRoute<
  TParams extends Record<string, string | string[]>,
  TBody = undefined,
  TQuery = undefined,
  TResult = unknown,
>(
  config: RouteConfig<TBody, TQuery>,
  handler: (ctx: RouteContext<TBody, TQuery, TParams>) => Promise<TResult>,
) {
  const run = makeRunner<TBody, TQuery, TParams, TResult>(config, handler);
  return async (
    request: Request,
    context: { params: Promise<TParams> },
  ): Promise<Response> => run(request, await context.params);
}

function makeRunner<TBody, TQuery, TParams, TResult>(
  config: RouteConfig<TBody, TQuery>,
  handler: (ctx: RouteContext<TBody, TQuery, TParams>) => Promise<TResult>,
) {
  return async (request: Request, params: TParams): Promise<Response> => {
    const start = Date.now();

    try {
      const user = config.auth === false ? (null as unknown as User) : await requireApiUser();

      let body = undefined as TBody;
      if (config.body) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw badRequest('Request body must be valid JSON');
        }
        const parsed = config.body.safeParse(raw);
        if (!parsed.success) {
          throw badRequest('Invalid request body', z.treeifyError(parsed.error));
        }
        body = parsed.data;
      }

      let query = undefined as TQuery;
      if (config.query) {
        const url = new URL(request.url);
        const parsed = config.query.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          throw badRequest('Invalid query parameters', z.treeifyError(parsed.error));
        }
        query = parsed.data;
      }

      const result = await handler({
        body,
        query,
        user,
        request,
        params,
        idempotencyKey: request.headers.get('idempotency-key'),
      });

      log.info(`${config.operation} ok`, {
        operation: config.operation,
        userId: user?.id,
        durationMs: Date.now() - start,
      });

      // A handler that has already built its own Response — a file download, say —
      // passes it through untouched. Everything else is JSON.
      if (result instanceof Response) return result;

      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      return toErrorResponse(error, config.operation, Date.now() - start);
    }
  };
}

export function toErrorResponse(error: unknown, operation: string, durationMs: number): Response {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json<ApiErrorBody>(
      { error: { code: 'unauthorized', message: error.message } },
      { status: 401 },
    );
  }

  if (error instanceof ApiError) {
    log.warn(`${operation} rejected`, {
      operation,
      durationMs,
      code: error.code,
      error: error.message,
    });
    return NextResponse.json<ApiErrorBody>(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }

  log.error(`${operation} threw`, {
    operation,
    durationMs,
    error: error instanceof Error ? error.message : String(error),
  });

  return NextResponse.json<ApiErrorBody>(
    { error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } },
    { status: 500 },
  );
}
