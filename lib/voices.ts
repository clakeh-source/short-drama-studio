/**
 * Picking a starting voice for each character.
 *
 * Nothing assigned `voiceId` at all before this: the bible writer does not emit
 * one and the picker is Phase 5 work, so every voice job died on "has no voice
 * assigned yet" and every episode came out silent. A series has to be able to
 * produce sound the moment its bible exists; choosing a *better* voice is then
 * an edit, like every other stage in this app.
 *
 * Pure and deterministic — same cast and same catalogue, same assignment — so
 * regenerating a bible does not silently reshuffle who sounds like whom.
 */

export interface VoiceOption {
  id: string;
  name: string;
  tags: string[];
}

/**
 * Role wording the model actually produces, mapped to the tags that suit it.
 * Matched against the role and, failing that, the character's own description.
 */
const ROLE_PREFERENCES: Array<{ pattern: RegExp; tags: string[] }> = [
  { pattern: /protagonist|lead|hero(ine)?/i, tags: ['lead', 'warm', 'young'] },
  { pattern: /antagonist|villain|rival|nemesis/i, tags: ['antagonist', 'cold', 'mature'] },
  { pattern: /narrator|voice[- ]?over/i, tags: ['narration', 'neutral'] },
  { pattern: /mentor|elder|parent|boss/i, tags: ['mature'] },
  { pattern: /ally|friend|sidekick|confidant/i, tags: ['warm'] },
];

function preferredTags(role: string): string[] {
  return ROLE_PREFERENCES.find((p) => p.pattern.test(role))?.tags ?? [];
}

/** How well a voice matches a set of wanted tags. Its name counts too, because
 *  catalogues tend to encode the useful hint there ("Vex (antagonist)"). */
function score(voice: VoiceOption, wanted: string[]): number {
  const haystack = [...voice.tags, voice.name, voice.id].join(' ').toLowerCase();
  return wanted.reduce((total, tag) => total + (haystack.includes(tag.toLowerCase()) ? 1 : 0), 0);
}

/**
 * Returns the voice id for each character, keyed by name.
 *
 * Distinct voices while the catalogue allows it — two characters sharing one
 * voice is confusing in a two-hander, which most short drama is. Once the
 * catalogue is exhausted it wraps around rather than leaving anyone mute.
 */
export function assignDefaultVoices(
  cast: ReadonlyArray<{ name: string; role: string }>,
  voices: ReadonlyArray<VoiceOption>,
): Map<string, string> {
  const assignment = new Map<string, string>();
  if (voices.length === 0) return assignment;

  const used = new Set<string>();

  for (const [index, character] of cast.entries()) {
    const wanted = preferredTags(character.role);

    const ranked = voices
      .map((voice, position) => ({ voice, position, points: score(voice, wanted) }))
      // Highest score first; ties broken by catalogue order so the result is
      // stable rather than dependent on sort implementation.
      .sort((a, b) => b.points - a.points || a.position - b.position);

    const pick =
      ranked.find((r) => r.points > 0 && !used.has(r.voice.id)) ??
      ranked.find((r) => !used.has(r.voice.id)) ??
      // Catalogue exhausted: wrap, so a large cast still gets voices.
      { voice: voices[index % voices.length]! };

    assignment.set(character.name, pick.voice.id);
    used.add(pick.voice.id);
  }

  return assignment;
}
