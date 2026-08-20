import { badRequest, route } from '@/lib/api/handler';
import { extractText, MAX_PASTED_CHARS } from '@/lib/script-import/extract';
import { parseScriptText } from '@/lib/script-import/parse';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Normalises a pasted or uploaded script and hands back the structure.
 *
 * Writes nothing and calls no model, so it is free to run as often as the user
 * likes — which is the point: they are meant to look at the result, fix the
 * scene breaks, and try again before anything is committed.
 *
 * Accepts either a JSON `{ text }` body or a multipart upload, because the two
 * input paths in the UI produce genuinely different request shapes and forcing
 * the client to base64 a .docx into JSON would be worse than branching here.
 */
export const POST = route(
  { operation: 'script.import_parse', rateLimit: RATE_LIMITS.upload },
  async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  let text: string;
  let filename: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('No file was uploaded.');
    filename = file.name;
    text = await extractText(file);
  } else {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw badRequest('Request body must be valid JSON, or a multipart upload.');
    }
    const value = (raw as { text?: unknown })?.text;
    if (typeof value !== 'string') throw badRequest('Send the script as `text`.');
    if (value.length > MAX_PASTED_CHARS) {
      throw badRequest(
        `That script is ${(value.length / 1024 / 1024).toFixed(1)}MB of text; the limit is ` +
          `${MAX_PASTED_CHARS / 1024 / 1024}MB. A feature-length screenplay is well under it.`,
      );
    }
    text = value;
  }

  if (!text.trim()) {
    throw badRequest(
      filename ? `"${filename}" has no readable text in it.` : 'That script is empty.',
    );
  }

  const result = parseScriptText(text);

  if (result.episodes.length === 0) {
    throw badRequest(
      'Nothing readable was found in that script. It needs at least one line of action or dialogue.',
    );
  }

  return { ...result, filename };
});

/** A long screenplay is a big multipart body and a lot of regex work. */
export const maxDuration = 60;
