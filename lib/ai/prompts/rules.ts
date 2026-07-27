/**
 * The short-drama form, encoded once and shared by every prompt.
 *
 * These are the structural rules the vertical short-drama format actually runs
 * on. They live here rather than inline in each prompt so the whole build has
 * one definition of the form, and so changing the format is a single edit.
 */

export const STRUCTURE_RULES = `SHORT-DRAMA STRUCTURE — non-negotiable:
- Cold open: the hook lands inside the first 3 seconds. No establishing shots, no
  throat-clearing, no "we open on". The first line or image is the disruption.
- One escalation every 15 seconds. Something must get materially worse — a new
  witness, a raised stake, a deadline, a reveal. Never two calm beats in a row.
- Reversal at roughly 70% through: the audience's understanding of who wants what
  flips. Not a twist for its own sake — a recontextualisation of what came before.
- Cliffhanger on the final line. The episode ends mid-consequence, on dialogue,
  not on a resolution or a summary.
- Dialogue lines are under 12 words. Characters interrupt, deflect and withhold.
  Nobody explains the plot to someone who already knows it.
- No voiceover narration. No exposition dumps. If the audience can infer it, cut it.`;

export const VISUAL_RULES = `VISUAL CONSISTENCY:
- Every character gets an appearance_prompt: a purely physical description used
  verbatim in every image and video prompt they appear in. Age range, build, hair,
  face, wardrobe, distinguishing marks.
- It must contain no names, no story, no emotion, no camera direction, no lighting.
  It describes only what a stranger would see. It must be reusable across every
  scene without editing.
- Wardrobe is fixed for the episode. Short drama is shot fast; characters do not
  change clothes between scenes unless the story turns on it.`;

export const SAFETY_RULES = `CONTENT RULES — hard limits:
- No real, named, identifiable people. Invent every character. If the premise
  names a real person, replace them with a fictional equivalent.
- Every character is an adult, and unambiguously reads as one. No sexual or
  romantic content involving anyone who could be read as a minor.
- No real brands, no real companies, no real institutions by name.`;

export const JSON_RULES = `OUTPUT FORMAT:
Return a single JSON object and nothing else. No prose before or after it. No
markdown code fences. No trailing commentary. Every field in the schema is
required unless explicitly marked optional.`;

/** Wraps structured request data so the model — and the stub — can find it. */
export function inputBlock(payload: unknown): string {
  return `<input>\n${JSON.stringify(payload, null, 2)}\n</input>`;
}
