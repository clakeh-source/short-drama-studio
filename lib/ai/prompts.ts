/**
 * The prompt composer.
 *
 * **This is not an LLM call.** It is a pure function that assembles a video
 * prompt by concatenating known strings in a fixed order. That is deliberate:
 * character consistency across shots depends on the *same* appearance text
 * appearing verbatim in every prompt the character is in, and a model asked to
 * "describe the character again" will paraphrase. Determinism is the feature.
 *
 * Fixed order, per the build spec:
 *   camera → subject appearance_prompt(s) verbatim → action →
 *   location / time-of-day → series style suffix → (negative prompt, separate)
 *
 * No imports, no I/O, no randomness — so it is trivially unit-testable and
 * produces byte-identical output for identical input.
 */

export const CAMERA_VOCABULARY = [
  'extreme close-up',
  'close-up',
  'medium',
  'wide',
  'over-shoulder',
  'POV',
  'insert',
] as const;

export type Camera = (typeof CAMERA_VOCABULARY)[number];

export function isCamera(value: string): value is Camera {
  return (CAMERA_VOCABULARY as readonly string[]).includes(value);
}

/**
 * Resolves loose input to a vocabulary term, case-insensitively, returning the
 * canonical spelling — `POV` is upper-case in the vocabulary, so a naive
 * lowercase comparison would silently demote every POV shot to a medium.
 *
 * Anything genuinely unrecognised becomes a medium shot rather than corrupting
 * the prompt with a term the video model will not understand.
 */
export function normaliseCamera(value: string | null | undefined): Camera {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return CAMERA_VOCABULARY.find((c) => c.toLowerCase() === trimmed) ?? 'medium';
}

/**
 * What every vertical short-drama shot wants suppressed. Kept here rather than
 * in the database so it improves for every existing series at once.
 */
export const DEFAULT_NEGATIVE_PROMPT =
  'blurry, low resolution, distorted face, deformed hands, extra fingers, ' +
  'watermark, text overlay, subtitles, logo, split screen, collage, ' +
  'horizontal letterboxing, camera shake, motion blur, oversaturated';

/** Falls back to this when the series bible carries no visual style. */
export const DEFAULT_STYLE_SUFFIX =
  'cinematic, shallow depth of field, natural skin texture, 9:16 vertical framing, ' +
  'contemporary drama grade';

export interface PromptCharacter {
  id: string;
  name: string;
  /** Reused verbatim. May be empty — see `fallbackAppearance`. */
  appearancePrompt: string;
  role?: string;
}

export interface ComposeVideoPromptInput {
  camera: string;
  action: string;
  location: string;
  timeOfDay: string;
  /** In shot order; only characters actually in the shot. */
  characters: PromptCharacter[];
  /** Series-level look. Defaults to DEFAULT_STYLE_SUFFIX when blank. */
  styleSuffix?: string | null;
  /**
   * A human's replacement for the whole composed prompt. When present it wins
   * outright — the point of an override is that the machine stops editing it.
   */
  override?: string | null;
}

/**
 * Stand-in for a character with no appearance text yet, so an insert or a
 * half-filled bible still yields a usable prompt instead of a dangling comma.
 */
export function fallbackAppearance(character: PromptCharacter): string {
  const role = character.role?.trim();
  return role
    ? `an adult ${role.toLowerCase()}, consistent appearance across shots`
    : 'an adult character, consistent appearance across shots';
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;\s]+$/, '');
}

/**
 * The composed positive prompt.
 *
 * Every character in `characters` contributes their `appearance_prompt`
 * verbatim, in order. That property is asserted directly in the tests: it is
 * what makes a face survive from shot 3 to shot 14.
 */
export function composeVideoPrompt(input: ComposeVideoPromptInput): string {
  const override = clean(input.override);
  if (override) return override;

  const segments: string[] = [];

  // 1. Camera.
  segments.push(`${normaliseCamera(input.camera)} shot`);

  // 2. Subjects, verbatim, in order.
  for (const character of input.characters) {
    const appearance = clean(character.appearancePrompt) || fallbackAppearance(character);
    segments.push(appearance);
  }

  // 3. Action.
  const action = clean(input.action);
  if (action) segments.push(action);

  // 4. Where and when.
  const place = [clean(input.location), clean(input.timeOfDay)].filter(Boolean).join(', ');
  if (place) segments.push(place);

  // 5. Series look.
  segments.push(clean(input.styleSuffix) || DEFAULT_STYLE_SUFFIX);

  return segments.join(', ');
}

export interface ComposeNegativePromptInput {
  /** Series-level additions, appended after the defaults. */
  extra?: string | null;
  /** Replaces the defaults entirely. */
  override?: string | null;
}

export function composeNegativePrompt(input: ComposeNegativePromptInput = {}): string {
  const override = clean(input.override);
  if (override) return override;

  const extra = clean(input.extra);
  return extra ? `${DEFAULT_NEGATIVE_PROMPT}, ${extra}` : DEFAULT_NEGATIVE_PROMPT;
}

/**
 * A still-frame prompt for the same shot. Same subjects and staging, minus the
 * motion verbs — used for reference images where the provider supports them.
 */
export function composeImagePrompt(input: ComposeVideoPromptInput): string {
  const override = clean(input.override);
  if (override) return override;
  return `${composeVideoPrompt({ ...input, override: null })}, single frame, no motion blur`;
}
