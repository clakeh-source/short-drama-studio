import type { GeneratedImage, ImageGenInput, ImageProvider } from '../types';
import { appOrigin, delay, failureFor, STUB_LATENCY_MS } from './support';

/**
 * Deterministic stand-in for the image model.
 *
 * Returns real, decodable PNGs rather than placeholder URLs: the confirm step
 * for reference stills inspects what actually landed in storage — content type
 * and byte length, read back from the object — so a fake URL would fail
 * validation and the whole character-stills path would be untestable without
 * spending money.
 *
 * The colour is derived from the prompt, so the same character produces the same
 * stills on every run and two characters never produce the same ones. That is
 * what lets a test assert "these three images belong to this character".
 */
const CENTS_PER_IMAGE = 1;

/** A 1x1 PNG in the given RGB, built by hand. Small, valid, and decodable. */
function pngDataUrl(r: number, g: number, b: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.from([0x00, r, g, b]);

  // zlib stored block — avoids pulling in a compressor for four bytes.
  const deflated = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff]),
    raw,
    (() => {
      let a = 1;
      let b2 = 0;
      for (const byte of raw) {
        a = (a + byte) % 65521;
        b2 = (b2 + a) % 65521;
      }
      const adler = Buffer.alloc(4);
      adler.writeUInt32BE(((b2 << 16) | a) >>> 0);
      return adler;
    })(),
  ]);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class StubImageProvider implements ImageProvider {
  readonly id = 'stub';
  readonly supportsIdentity = true;

  estimateCostCents(input: ImageGenInput): number {
    return Math.max(1, input.count * CENTS_PER_IMAGE);
  }

  async generate(
    input: ImageGenInput,
  ): Promise<{ images: GeneratedImage[]; costCents: number }> {
    const failure = failureFor(input.prompt);
    if (failure) {
      await delay(200);
      throw new Error(failure.error);
    }

    await delay(Math.min(STUB_LATENCY_MS, 500));

    /**
     * The identity channel, made observable.
     *
     * When a reference face is supplied the red channel is derived from *it*
     * rather than from the prompt, so every image conditioned on the same face
     * shares that value while the prompt still varies the rest. That is what
     * lets a test assert "these three stills are the same person" against a
     * fake provider — without it, identity-preservation would be a code path
     * nothing could check until it was pointed at a real model.
     */
    const identity = input.identityImageUrl?.trim();
    const base = hash(identity ?? input.prompt);

    const images = Array.from({ length: input.count }, (_, i) => {
      const seed = hash(`${input.prompt}:${i}`);
      return {
        url: pngDataUrl((base >> 16) & 0xff, (seed >> 8) & 0xff, seed & 0xff),
        contentType: 'image/png',
      };
    });

    return { images, costCents: Math.max(1, images.length * CENTS_PER_IMAGE) };
  }
}

/** Exported so a test can point at the app when it needs an http(s) URL. */
export const stubImageOrigin = appOrigin;
