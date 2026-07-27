import { badRequest, route } from '@/lib/api/handler';
import { extractText } from '@/lib/script-import/extract';
import { parseScriptText } from '@/lib/script-import/parse';

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
export const POST = route({ operation: 'script.import_parse' }, async ({ request }) => {
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
