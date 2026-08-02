import { deflateSync } from 'node:zlib';
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

/**
 * The frame a stub image fills.
 *
 * This used to emit a 1x1 pixel. It was valid, decodable and tiny — and it
 * meant a character's reference stills rendered as nothing at all, so a run
 * that generated a full cast looked exactly like a run that generated no
 * characters. The image *was* there; there was simply nothing to see.
 *
 * 9:16 at a modest size, so a still looks like a portrait in a grid, scales
 * without pixelating in a card, and still compresses to a couple of kilobytes
 * because it is flat colour.
 */
const STUB_WIDTH = 360;
const STUB_HEIGHT = 640;

/** A PNG of flat colour, built by hand. Valid, decodable, and visible. */
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
  ihdr.writeUInt32BE(STUB_WIDTH, 0);
  ihdr.writeUInt32BE(STUB_HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  /**
   * Scanlines, each with a leading filter byte.
   *
   * The top-left pixel carries the exact RGB the caller asked for, untouched by
   * any shading, because that pixel is the identity channel every test reads
   * back. A band across the lower third makes the placeholder legible as a
   * placeholder rather than as a solid rectangle someone might mistake for a
   * failed render.
   */
  const row = (shade: number): Buffer => {
    const line = Buffer.alloc(1 + STUB_WIDTH * 3);
    for (let x = 0; x < STUB_WIDTH; x++) {
      line[1 + x * 3] = Math.min(255, Math.round(r * shade));
      line[2 + x * 3] = Math.min(255, Math.round(g * shade));
      line[3 + x * 3] = Math.min(255, Math.round(b * shade));
    }
    return line;
  };

  const raw = Buffer.concat(
    Array.from({ length: STUB_HEIGHT }, (_, y) => row(y > STUB_HEIGHT * 0.66 ? 0.55 : 1)),
  );
  // The identity pixel, restored exactly after the shading pass.
  raw[1] = r;
  raw[2] = g;
  raw[3] = b;

  const deflated = deflateSync(raw);

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
  /** The stub encodes one identity, so it reads one. */
  readonly identityCapacity = 1;

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
    const identity = input.identityImageUrls?.map((u) => u.trim()).filter(Boolean).join('|') || undefined;
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
