import 'server-only';

import { badRequest } from '@/lib/api/handler';

/**
 * Gets plain text out of an uploaded script so the parser has one input shape.
 *
 * Deliberately thin: the parser is where the intelligence lives, and it works on
 * text. Every format supported here has to reduce to lines, which is also why
 * .pdf is absent — its text has no reliable line structure, and a script parsed
 * from one would be a worse experience than asking the user to paste.
 */

/** What the file picker offers, and what the route enforces. */
export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.fountain', '.docx'] as const;

/**
 * 2 MB. A feature-length screenplay is well under 200 KB of text, so anything
 * larger is a mistake worth catching before it reaches the parser.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export async function extractText(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw badRequest(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Paste the script instead if it is genuinely that long.`,
    );
  }

  const extension = extensionOf(file.name);

  if (extension === '.docx') {
    const buffer = Buffer.from(await file.arrayBuffer());
    // Imported lazily: mammoth pulls in a sizeable dependency tree, and a user
    // who only ever pastes should not pay for loading it.
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if ((ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return await file.text();
  }

  throw badRequest(
    `Cannot read "${file.name}". Upload ${ACCEPTED_EXTENSIONS.join(', ')}, or paste the script.`,
  );
}
