import { eq } from 'drizzle-orm';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { series } from '@/lib/db/schema';
import { loadSeries } from '@/lib/data/series';
import { uploadBuffer } from '@/lib/storage';
import { log } from '@/lib/log';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * The optional music bed for a series.
 *
 * The user supplies their own file — the spec is explicit that any library is
 * theirs to provide, and this app ships no music. Nothing here checks
 * licensing, so the upload copy says plainly that it is the user's
 * responsibility.
 */

const MAX_BYTES = 20 * 1024 * 1024;

/** Boundary lines and headers, so a file at the limit is not rejected for its envelope. */
const MULTIPART_OVERHEAD_BYTES = 8 * 1024;

const ACCEPTED = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
]);

/**
 * Multipart, so it reads the body itself rather than declaring a Zod schema —
 * `dynamicRoute` only touches the body when one is configured. Everything else
 * is the shared wrapper: session, ownership, structured logging, and the error
 * envelope.
 *
 * It used to be written by hand, with a catch that returned `error.message` for
 * anything it caught. A storage or database failure therefore handed its
 * internal message to the client under an HTTP 500 — the single route that
 * escaped `toErrorResponse`, which exists to stop exactly that.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'series.music.upload', rateLimit: RATE_LIMITS.upload },
  async ({ params, request, user }) => {
    // Confirms ownership through RLS before anything is written to storage.
    await loadSeries(user.id, params.id);

    /**
     * Checked before `formData()`, which buffers the whole body into memory.
     * The declared length can lie, so `file.size` is still checked below — this
     * is only about not reading 500MB to find out we did not want it.
     */
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw badRequest(
        `That upload is ${(declared / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.`,
      );
    }

    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      throw badRequest('Attach an audio file in the `file` field.');
    }
    if (file.size > MAX_BYTES) {
      throw badRequest(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.`,
      );
    }
    if (file.type && !ACCEPTED.has(file.type)) {
      throw badRequest(`${file.type} is not a supported audio format. Use MP3, WAV, AAC or M4A.`);
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? 'mp3';
    const stored = await uploadBuffer({
      bucket: 'audio',
      path: `${user.id}/series/${params.id}/music.${extension}`,
      buffer: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || 'audio/mpeg',
    });

    await withUserDb(user.id, (tx) =>
      tx
        .update(series)
        .set({ musicStoragePath: stored.storagePath })
        .where(eq(series.id, params.id)),
    );

    log.info('music bed uploaded', {
      userId: user.id,
      seriesId: params.id,
      operation: 'series.music.upload',
      bytes: stored.bytes,
    });

    return { uploaded: true, bytes: stored.bytes };
  },
);

/** Removes the music bed. */
export const DELETE = dynamicRoute<{ id: string }>(
  { operation: 'series.music.delete' },
  async ({ params, user }) => {
    const { series: row } = await loadSeries(user.id, params.id);
    if (!row) throw notFound('Series not found');

    await withUserDb(user.id, (tx) =>
      tx.update(series).set({ musicStoragePath: null }).where(eq(series.id, params.id)),
    );

    return { removed: true };
  },
);
