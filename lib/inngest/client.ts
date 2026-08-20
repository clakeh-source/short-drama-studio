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
 * Episode fan-out is keyed by the caller's idempotency key when one is supplied,
 * so a retried HTTP request cannot double-enqueue a whole episode.
 */
export function episodeGenerateEventId(episodeId: string, key: string | null): string {
  return `episode-generate:${episodeId}:${key ?? Date.now()}`;
}

/**
 * Keyed by attempt so a double-clicked "Render" dedupes, while a retry after a
 * failure is a distinct event and goes through.
 */
export function episodeRenderEventId(episodeId: string, attempt: number): string {
  return `episode-render:${episodeId}:${attempt}`;
}
