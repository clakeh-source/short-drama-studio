import 'server-only';

import { randomUUID } from 'node:crypto';
import { getImageProvider } from '@/lib/providers';
import { downloadToBuffer, signedUrl, uploadBuffer } from '@/lib/storage';
import { log } from '@/lib/log';
import type { ShotReferenceSet } from '@/lib/characters/reference-set';

/**
 * The first frame of a shot, drawn before the shot is filmed.
 *
 * Kling conditions on exactly one image per clip — a start frame — which left
 * two problems that look like one:
 *
 *   1. In a two-hander, only the first-billed character's portrait was sent.
 *      The second person was described in the prompt and drawn from scratch, so
 *      they were a different stranger in every shot they appeared in.
 *   2. The start frame was a *studio portrait*. The clip therefore opened on a
 *      grey backdrop and had to travel to the harbour terminal in five seconds,
 *      which is a bad use of the only frame the model is sure about.
 *
 * Both are the same mistake: conditioning on a picture of a person when what is
 * needed is a picture of the *shot*. So this draws that picture — the right
 * location, the right framing, the right people — from the shot's own prompt
 * with every character's face supplied as an identity reference, and hands that
 * to the video model instead.
 *
 * The keyframe is stored like any other asset, so a reviewer can see the frame a
 * clip was built from, and a regeneration can reuse it.
 */

/**
 * How long the keyframe stays fetchable.
 *
 * The video provider pulls it when the job starts, which on a busy queue can be
 * long after submission. Matches the reference-still TTL for the same reason:
 * an expired URL means the clip is generated from the prompt alone, and nothing
 * downstream can tell that happened.
 */
const KEYFRAME_URL_TTL_SECONDS = 6 * 60 * 60;

/** Turning keyframes off falls back to conditioning on the canonical stills. */
export function keyframesEnabled(): boolean {
  return process.env.SHOT_KEYFRAMES !== 'off';
}

export interface ShotKeyframe {
  /** `bucket/path` of the stored frame. */
  storagePath: string;
  /** Signed URL for the video provider to fetch. */
  url: string;
  bytes: number;
  contentType: string;
  costCents: number;
  /** How many of the shot's characters the image model actually conditioned on. */
  facesUsed: number;
  /** Every character the shot wanted in frame, whether or not the model took them. */
  facesRequested: number;
}

export interface BuildKeyframeInput {
  userId: string;
  episodeId: string;
  shotId: string;
  version: number;
  /** The shot's composed video prompt — location, framing, action, cast. */
  prompt: string;
  negativePrompt?: string | null;
  /** Canonical stills of everyone in the shot, in billing order. */
  references: ShotReferenceSet;
}

/**
 * Draws and stores a shot's start frame.
 *
 * Returns null rather than throwing when there is nothing to gain — no cast to
 * hold identity for, or keyframes switched off — so the caller falls back to
 * the previous behaviour instead of failing a shot over an optimisation.
 */
export async function buildShotKeyframe(
  input: BuildKeyframeInput,
): Promise<ShotKeyframe | null> {
  if (!keyframesEnabled()) return null;

  const provider = getImageProvider();

  /**
   * With no faces to preserve there is still a case for a keyframe — it would
   * set the location — but not a strong one: a text-to-video clip generated
   * from the same prompt is as good and costs one fewer image. Keyframes exist
   * for identity, so no identity means no keyframe.
   */
  if (input.references.urls.length === 0 || !provider.supportsIdentity) return null;

  const result = await provider.generate({
    // The shot's own prompt, not a portrait brief. This frame has to look like
    // the film, because it is the first frame of it.
    prompt: input.prompt,
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    count: 1,
    aspectRatio: '9:16',
    identityImageUrls: input.references.urls,
  });

  const image = result.images[0];
  if (!image) return null;

  const downloaded = await downloadToBuffer(image.url);
  const contentType = image.contentType || downloaded.contentType;

  const stored = await uploadBuffer({
    bucket: 'references',
    // Alongside the clip it belongs to rather than with the character stills:
    // this frame is a property of the shot and dies with it.
    path: `${input.userId}/${input.episodeId}/keyframes/${input.shotId}/v${input.version}-${randomUUID()}.${
      contentType === 'image/png' ? 'png' : 'jpg'
    }`,
    buffer: downloaded.buffer,
    contentType,
  });

  const url = await signedUrl(stored.storagePath, KEYFRAME_URL_TTL_SECONDS);
  if (!url) {
    log.warn('could not sign the shot keyframe; falling back to character stills', {
      ...input,
      operation: 'shot.keyframe.sign_failed',
      references: undefined,
    });
    return null;
  }

  /**
   * How many faces the model *actually* read — the provider's declared capacity,
   * capped by how many were available.
   *
   * A two-hander sent to a single-identity model conditions on one face and the
   * other character is still drawn from the prompt. Recorded rather than
   * assumed, because "we sent two" and "it used two" are different claims and
   * only the second one fixes the two-hander.
   */
  const facesUsed = Math.min(provider.identityCapacity, input.references.urls.length);

  log.info('shot keyframe drawn', {
    userId: input.userId,
    shotId: input.shotId,
    operation: 'shot.keyframe',
    provider: provider.id,
    facesRequested: input.references.urls.length,
    facesUsed,
    characters: input.references.characters.map((c) => c.name),
    costCents: result.costCents,
  });

  return {
    storagePath: stored.storagePath,
    url,
    bytes: stored.bytes,
    contentType,
    costCents: result.costCents,
    facesUsed,
    facesRequested: input.references.urls.length,
  };
}
