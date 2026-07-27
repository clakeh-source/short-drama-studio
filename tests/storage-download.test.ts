import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadToBuffer } from '@/lib/storage';

/**
 * `downloadToBuffer` has to read from disk as well as the network.
 *
 * The local ffmpeg render adapter hands back a `file://` URL, and Node's `fetch`
 * refuses that scheme outright — it throws `TypeError: fetch failed` with a cause
 * of "not implemented... yet...". So `RENDER_PROVIDER=ffmpeg` could finish a whole
 * encode and then fail to store the result. It went unnoticed because the
 * missing-libass guard failed those renders earlier, so the ingest step was never
 * reached until libass was installed.
 */
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sds-storage-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('downloadToBuffer', () => {
  it('reads a file:// URL from disk', async () => {
    const file = join(workDir, 'episode.mp4');
    await writeFile(file, Buffer.from('not really an mp4, but bytes are bytes'));

    const { buffer, contentType } = await downloadToBuffer(pathToFileURL(file).href);

    expect(buffer.toString()).toBe('not really an mp4, but bytes are bytes');
    expect(contentType).toBe('video/mp4');
  });

  it('handles a path containing spaces, which URL-encodes', async () => {
    const file = join(workDir, 'my episode (final).mp4');
    await writeFile(file, Buffer.from('ok'));

    // `pathToFileURL` percent-encodes; a naive `slice(7)` would look for a
    // literal "%20" on disk and fail.
    const url = pathToFileURL(file).href;
    expect(url).toContain('%20');

    const { buffer } = await downloadToBuffer(url);
    expect(buffer.toString()).toBe('ok');
  });

  it('rejects an empty rendered file rather than storing zero bytes', async () => {
    const file = join(workDir, 'empty.mp4');
    await writeFile(file, Buffer.alloc(0));

    await expect(downloadToBuffer(pathToFileURL(file).href)).rejects.toThrow(/empty/i);
  });

  it('surfaces a missing file as an error, not as an empty buffer', async () => {
    const url = pathToFileURL(join(workDir, 'does-not-exist.mp4')).href;
    await expect(downloadToBuffer(url)).rejects.toThrow();
  });

  it('falls back to a generic content type for a non-mp4 local file', async () => {
    const file = join(workDir, 'clip.webm');
    await writeFile(file, Buffer.from('x'));

    const { contentType } = await downloadToBuffer(pathToFileURL(file).href);
    expect(contentType).toBe('application/octet-stream');
  });
});
