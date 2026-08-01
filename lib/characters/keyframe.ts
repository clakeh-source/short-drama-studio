import 'server-only';

import { randomUUID } from 'node:crypto';
import { getImageProvider } from '@/lib/providers';
import { downloadToBuffer, signedUrl, uploadBuffer } from '@/lib/storage';
import { log } from '@/lib/log';
import type { ShotReferenceSet } from '@/lib/characters/reference-set';

/**
 * The first frame of a shot, drawn before the shot is filmed.
 *
 * This was built to solve two problems at once, back when the video model was
 * thought to condition on exactly one image per clip:
 *
 *   1. In a two-hander, only the first-billed character's portrait was sent.
 *      The second person was described in the prompt and drawn from scratch, so
 *      they were a different stranger in every shot they appeared in.
 *   2. The start frame was a *studio portrait*. The clip therefore opened on a
 *      grey backdrop and had to travel to the harbour terminal in five seconds,
 *      which is a bad use of the only frame the model is sure about.
 *
 * **The first of those is no longer this file's job.** Kling's image-to-video
 * endpoint takes `elements` — a group of stills per character — so identity is
 * now held where it belongs, at the video call, for every character in the shot
 * rather than for as many faces as one image model could encode. See
 * `lib/providers/fal/elements.ts`.
 *
 * The second problem is still real and still worth a picture: elements say who
 * is in the clip and nothing whatever about where it is or how it is framed.
 * So the keyframe stays, as a *composition* — the right location, the right
 * blocking, the right lens — and the video model gets it as a start frame.
 *
 * It is still drawn with identity conditioning even though identity is handled
 * downstream, because a start frame showing different faces than the elements
 * would put the two instructions in conflict on frame one.
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
   * A shot with nobody in it gets no keyframe.
   *
   * The composition argument would apply here too — the frame would still set
   * the location. But a shot with no cast goes to text-to-video, which is given
   * the same prompt and arrives at the same place for one image less. The
   * keyframe earns its 5c only where there are people to place in the frame.
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
   * This is a fact about the frame, not about the clip. It used to be the
   * number that answered "did the two-hander hold", and it is not that any
   * more: the clip's identities come from the video call's elements, and this
   * says only how many of them the start frame managed to show. A low number
   * here now means a start frame that under-represents its own cast, which is
   * worth knowing and is no longer the whole story.
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
