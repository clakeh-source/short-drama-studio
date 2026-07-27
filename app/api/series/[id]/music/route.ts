import { eq } from 'drizzle-orm';
import { badRequest, dynamicRoute, notFound } from '@/lib/api/handler';
import { requireApiUser } from '@/lib/auth';
import { withUserDb } from '@/lib/db';
import { series } from '@/lib/db/schema';
import { loadSeries } from '@/lib/data/series';
import { uploadBuffer } from '@/lib/storage';
import { log } from '@/lib/log';

/**
 * The optional music bed for a series.
 *
 * The user supplies their own file — the spec is explicit that any library is
 * theirs to provide, and this app ships no music. Nothing here checks
 * licensing, so the upload copy says plainly that it is the user's
 * responsibility.
 */

const MAX_BYTES = 20 * 1024 * 1024;

const ACCEPTED = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
]);

/**
 * Multipart, so this one route is written by hand rather than through the JSON
 * `route()` wrapper. Auth and ownership are still enforced the same way.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  let user;
  try {
    user = await requireApiUser();
  } catch {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Not signed in' } },
      { status: 401 },
    );
  }

  try {
    // Confirms ownership through RLS before anything is written to storage.
    await loadSeries(user.id, id);

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
      path: `${user.id}/series/${id}/music.${extension}`,
      buffer: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || 'audio/mpeg',
    });

    await withUserDb(user.id, (tx) =>
      tx.update(series).set({ musicStoragePath: stored.storagePath }).where(eq(series.id, id)),
    );

    log.info('music bed uploaded', {
      userId: user.id,
      seriesId: id,
      operation: 'series.music.upload',
      bytes: stored.bytes,
    });

    return Response.json({ uploaded: true, bytes: stored.bytes });
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : 'Could not upload that file.';
    return Response.json({ error: { code: 'bad_request', message } }, { status });
  }
}

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
