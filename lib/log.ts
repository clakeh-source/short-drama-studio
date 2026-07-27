/**
 * Structured JSON logging. Every provider call and route handler emits one
 * line so spend and latency are greppable in production logs.
 */

export interface LogContext {
  userId?: string;
  seriesId?: string;
  episodeId?: string;
  shotId?: string;
  provider?: string;
  operation?: string;
  durationMs?: number;
  costCents?: number;
  [key: string]: unknown;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, context: LogContext = {}): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...context,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
};

/**
 * Wraps an operation so it always logs duration and outcome. Used for every
 * provider call from Phase 3 onwards.
 */
export async function logged<T>(
  operation: string,
  context: LogContext,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(`${operation} ok`, { ...context, operation, durationMs: Date.now() - start });
    return result;
  } catch (error) {
    log.error(`${operation} failed`, {
      ...context,
      operation,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
