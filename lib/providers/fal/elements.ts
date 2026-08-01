import type { VideoCastReference } from '../types';

/**
 * Kling's `elements` — several people held in one clip.
 *
 * The old arrangement conditioned a clip on a single start frame, so a
 * two-hander preserved one face and drew the other from the prompt. `elements`
 * is the endpoint's answer: each character travels as their own group of
 * stills, and the *prompt* points at them by position — `@Element1`,
 * `@Element2` — rather than by name.
 *
 * That last part is the whole difficulty. Our prompts are written by a language
 * model in ordinary prose ("Mei turns from the window"), and the model here
 * wants "@Element1 turns from the window". So the names have to be found in the
 * prompt and rewritten, over text nobody wrote to be machine-edited. Everything
 * below is about doing that conservatively: an unrecognised name costs a
 * mention, while an over-eager match corrupts the sentence.
 */

/**
 * How many characters travel as elements.
 *
 * fal's schema documents a budget of "7 total (elements + reference images +
 * start image)" without saying whether each element's own angles count against
 * it. Four stays comfortably inside either reading, matches the identity
 * capacity the image path uses, and is above any shot this app plans — the
 * storyboard writes two- and three-handers, not crowd scenes.
 */
export const MAX_ELEMENTS = 4;

/** "Additional reference images from different angles. 1-3 images supported." */
export const MAX_ANGLES_PER_ELEMENT = 3;

/**
 * What a given Kling model actually accepts.
 *
 * The model id is configurable, and the generations differ in ways that fail
 * *silently* rather than loudly: v1.6, v2.1 and v2.5 take the start frame as
 * `image_url` and have no `elements` field at all, while v3 and o1 take
 * `start_image_url` and do. Send a v3 body to v2.1 and the start frame is
 * dropped — every clip becomes text-to-video with a longer request, and the
 * only symptom is that faces drift.
 *
 * Verified against fal's OpenAPI schema for each endpoint rather than its docs
 * prose, which is how the `image_url`/`start_image_url` split was found in the
 * first place.
 */
export interface KlingCapabilities {
  /** Field the start frame goes in. */
  startImageField: 'start_image_url' | 'image_url';
  /** Whether the model reads `elements`, i.e. can hold several faces at once. */
  elements: boolean;
}

const V3_AND_LATER: KlingCapabilities = { startImageField: 'start_image_url', elements: true };
const PRE_V3: KlingCapabilities = { startImageField: 'image_url', elements: false };

export function capabilitiesFor(model: string): KlingCapabilities {
  // Anchored on a path segment so `v1.6` cannot match inside a customer's own
  // model name, and so `v10` will not one day read as `v1`.
  if (/\/(v1(\.\d+)?|v2(\.\d+)?(-\w+)?)\//i.test(model)) return PRE_V3;

  /**
   * Everything else — v3, o1, and anything newer — gets the current shape.
   *
   * An unknown model is assumed to be newer rather than older, because that is
   * the direction model ids move and because the alternative silently degrades
   * a capable model to a start frame it cannot read.
   */
  return V3_AND_LATER;
}

/** What one character looks like in the request body. */
export interface KlingElement {
  frontal_image_url: string;
  reference_image_urls?: string[];
}

export interface ComposedElements {
  /** The prompt, with cast names rewritten as `@ElementN`. */
  prompt: string;
  elements: KlingElement[];
  /** Per element, whether its name was found in the prompt rather than appended. */
  referenced: boolean[];
  /** Names that had to be introduced, for the log. */
  introduced: string[];
}

/**
 * Letters, digits and underscore in any script.
 *
 * `\b` is ASCII-only, so it fires in the middle of a name like "José" and
 * misses the boundary it was meant to find. These lookarounds are the same idea
 * done in Unicode, which matters because character names come from a model
 * writing in whatever language the premise was in.
 */
const BEFORE = '(?<![\\p{L}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{N}_])';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(prompt: string, name: string): boolean {
  return new RegExp(`${BEFORE}${escape(name)}${AFTER}`, 'iu').test(prompt);
}

/**
 * Rewrites every whole-word occurrence of `name`, whatever its case.
 *
 * All occurrences, not just the first: a prompt that says "Mei" three times
 * should say "@Element1" three times, or the model is left holding one tagged
 * reference and two strangers who happen to share a name.
 */
function rewrite(prompt: string, name: string, tag: string): string {
  return prompt.replace(new RegExp(`${BEFORE}${escape(name)}${AFTER}`, 'giu'), tag);
}

/**
 * Turns a shot's cast into elements, and its prompt into one that points at
 * them.
 *
 * Matching runs full names first and then first names, because "Mei Lin" and a
 * later bare "Mei" are the same person and both have to become the same tag. A
 * first name shared by two cast members is skipped rather than guessed at —
 * tagging the wrong face is worse than leaving prose alone, and it is the kind
 * of wrong that only shows up in the finished clip.
 */
export function composeElements(
  prompt: string,
  cast: readonly VideoCastReference[],
): ComposedElements {
  const usable = cast
    .map((member) => ({ name: member.name.trim(), urls: member.urls.filter((u) => u.trim()) }))
    .filter((member) => member.name.length > 0 && member.urls.length > 0)
    .slice(0, MAX_ELEMENTS);

  if (usable.length === 0) return { prompt, elements: [], referenced: [], introduced: [] };

  const firstNames = usable.map((member) => member.name.split(/\s+/)[0] ?? '');
  const ambiguous = new Set(
    firstNames
      .map((name) => name.toLowerCase())
      .filter((name, _, all) => all.filter((other) => other === name).length > 1),
  );

  let composed = prompt;
  const referenced: boolean[] = [];

  usable.forEach((member, index) => {
    const tag = `@Element${index + 1}`;
    const first = firstNames[index]!;

    const byFullName = mentions(composed, member.name);
    if (byFullName) composed = rewrite(composed, member.name, tag);

    // Only after the full name, so "Mei Lin ... Mei" collapses to one tag. Not
    // at all when two characters answer to the same first name.
    const byFirstName =
      first.length > 0 &&
      first.toLowerCase() !== member.name.toLowerCase() &&
      !ambiguous.has(first.toLowerCase()) &&
      mentions(composed, first);
    if (byFirstName) composed = rewrite(composed, first, tag);

    referenced.push(byFullName || byFirstName);
  });

  /**
   * A character the prompt never names by name — "the ferryman", or a name the
   * storyboard shortened past recognition.
   *
   * The element is still sent, and introduced in the syntax the field
   * documents, because dropping it would silently return that character to
   * being redrawn from scratch in every shot. Appended rather than woven in:
   * this is machine text and it should read as machine text, not as a sentence
   * someone wrote.
   */
  const introduced = usable
    .filter((_, index) => !referenced[index])
    .map((member) => member.name);

  if (introduced.length > 0) {
    const clauses = usable
      .map((member, index) => (referenced[index] ? null : `@Element${index + 1} is ${member.name}.`))
      .filter((clause): clause is string => clause !== null);
    composed = `${composed.trimEnd()} ${clauses.join(' ')}`;
  }

  return {
    prompt: composed,
    elements: usable.map((member) => ({
      frontal_image_url: member.urls[0]!,
      ...(member.urls.length > 1
        ? { reference_image_urls: member.urls.slice(1, MAX_ANGLES_PER_ELEMENT + 1) }
        : {}),
    })),
    referenced,
    introduced,
  };
}
