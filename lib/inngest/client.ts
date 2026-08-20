import { createHash } from 'node:crypto';

import { EventSchemas, Inngest } from 'inngest';

import { inngestIsDev } from './mode';

/**
 * Typed event catalogue.
 *
 * Declared as a TypeScript record rather than via `EventSchemas.fromZod`: that
 * bridge is typed against Zod 3, and this project is on Zod 4. Payloads that
 * cross a trust boundary are still Zod-validated at the route handler, which is
 * where validation actually belongs — events are emitted by our own server.
 *
 * Every generation event carries `userId` because it is the Inngest concurrency
 * key: three in-flight video jobs per user, no matter how many episodes they
 * kick off at once.
 */
export type Events = {
  'demo/hello.world': {
    data: { name: string };
  };

  /** Fan-out: turn an episode's pending shots into per-shot jobs. */
  'episode/generate.requested': {
    data: {
      userId: string;
      episodeId: string;
      /** Only regenerate these; omit for "everything still pending". */
      shotIds?: string[];
    };
  };

  /** One video clip for one shot. */
  'shot/video.requested': {
    data: {
      userId: string;
      episodeId: string;
      shotId: string;
      /** 0 for the first go; increments on each automatic or manual retry. */
      attempt: number;
    };
  };

  /** Assemble an episode's finished clips into a single MP4. */
  'episode/render.requested': {
    data: {
      userId: string;
      episodeId: string;
      attempt: number;
    };
  };

  /** One voice clip for one shot's line of dialogue. */
  'shot/voice.requested': {
    data: {
      userId: string;
      episodeId: string;
      shotId: string;
      attempt: number;
    };
  };
};

export const inngest = new Inngest({
  id: 'short-drama-studio',
  schemas: new EventSchemas().fromRecord<Events>(),
  eventKey: process.env.INNGEST_EVENT_KEY,
  /**
   * Stated, not inferred. The SDK decides whether to verify the signature on
   * every request to /api/inngest from this mode, and left to itself it reads
   * an unrecognised environment as dev — which skips verification entirely. See
   * `inngestIsDev`.
   */
  isDev: inngestIsDev(),
});

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Inngest deduplicates events that share an `id` within 24 hours, which is
 * exactly the idempotency guarantee the spec asks for. Keying on the attempt
 * means a double-clicked "Generate" is a no-op, while a genuine retry — which
 * increments the attempt — is allowed through.
 */
export function shotVideoEventId(shotId: string, attempt: number): string {
  return `shot-video:${shotId}:${attempt}`;
}

export function shotVoiceEventId(shotId: string, attempt: number): string {
  return `shot-voice:${shotId}:${attempt}`;
}

/**
 * Episode fan-out, keyed by *what is being generated* rather than by when it was
 * asked for.
 *
 * This used to fall back to `Date.now()`, and the only caller minted a fresh
 * `episode-<id>-<Date.now()>` header on every click — so no two requests ever
 * shared a key and the dedup this function documents never once applied. (Money
 * was still safe: the per-shot ids below dedup during fan-out. The guarantee
 * stated here was simply not the one being provided.)
 *
 * `shotSetFingerprint` is the honest key. Two clicks on the same pending shots
 * produce the same id and the second is dropped; a retry advances a shot's
 * attempt, which changes the fingerprint, so genuine re-generation goes through.
 * An explicit `idempotency-key` header still wins, for callers that want to pin
 * a retry themselves.
 */
export function episodeGenerateEventId(episodeId: string, key: string): string {
  return `episode-generate:${episodeId}:${key}`;
}

/**
 * A stable digest of the shots a generate request would enqueue, each with the
 * attempt it would run as. Hashed because an episode can carry 200 shots and an
 * event id has to stay a reasonable length.
 */
export function shotSetFingerprint(shots: Array<{ id: string; retryCount: number }>): string {
  const canonical = shots
    .map((shot) => `${shot.id}:${shot.retryCount}`)
    .sort()
    .join(',');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Keyed by attempt so a double-clicked "Render" dedupes, while a retry after a
 * failure is a distinct event and goes through.
 */
export function episodeRenderEventId(episodeId: string, attempt: number): string {
  return `episode-render:${episodeId}:${attempt}`;
}
