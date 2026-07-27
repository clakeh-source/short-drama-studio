import { describe, expect, it } from 'vitest';
import { assignDefaultVoices, type VoiceOption } from '@/lib/voices';
import { requiredAssetKinds } from '@/lib/data/generation';

const catalogue: VoiceOption[] = [
  { id: 'stub-voice-lead-f', name: 'Mara (lead, female)', tags: ['female', 'young', 'warm'] },
  { id: 'stub-voice-lead-m', name: 'Dane (lead, male)', tags: ['male', 'young', 'gritty'] },
  { id: 'stub-voice-antag', name: 'Vex (antagonist)', tags: ['male', 'mature', 'cold'] },
  { id: 'stub-voice-narrator', name: 'Narrator', tags: ['neutral', 'narration'] },
];

const cast = [
  { name: 'Mara Vance', role: 'protagonist' },
  { name: 'Dane Ashford', role: 'antagonist' },
  { name: 'Iris Calloway', role: 'ally' },
  { name: 'Tobin Reyes', role: 'wildcard' },
];

describe('assignDefaultVoices', () => {
  it('gives every character a voice', () => {
    const assignment = assignDefaultVoices(cast, catalogue);
    expect(assignment.size).toBe(cast.length);
    for (const character of cast) {
      expect(assignment.get(character.name), character.name).toBeTruthy();
    }
  });

  it('routes roles to voices that suit them', () => {
    const assignment = assignDefaultVoices(cast, catalogue);
    expect(assignment.get('Mara Vance')).toBe('stub-voice-lead-f');
    expect(assignment.get('Dane Ashford')).toBe('stub-voice-antag');
  });

  it('avoids handing two characters the same voice', () => {
    const assignment = assignDefaultVoices(cast, catalogue);
    expect(new Set(assignment.values()).size).toBe(cast.length);
  });

  it('is deterministic, so re-rolling a bible does not reshuffle the cast', () => {
    const a = assignDefaultVoices(cast, catalogue);
    const b = assignDefaultVoices(cast, catalogue);
    expect([...a]).toEqual([...b]);
  });

  it('wraps rather than leaving anyone mute when the catalogue is smaller than the cast', () => {
    const assignment = assignDefaultVoices(cast, [catalogue[0]!]);
    expect(assignment.size).toBe(cast.length);
    expect(new Set(assignment.values())).toEqual(new Set(['stub-voice-lead-f']));
  });

  it('returns nothing, rather than throwing, on an empty catalogue', () => {
    expect(assignDefaultVoices(cast, []).size).toBe(0);
  });
});

describe('requiredAssetKinds', () => {
  /**
   * The video job used to set `ready` on its own, so an episode whose every
   * voice job had failed still showed a green board and an enabled Render
   * button — a silent film, one click away from export.
   */
  it('requires a voice only when the shot has a line', () => {
    expect(requiredAssetKinds({ dialogue: 'You lied to me.' })).toEqual(['video', 'voice']);
    expect(requiredAssetKinds({ dialogue: null })).toEqual(['video']);
    expect(requiredAssetKinds({ dialogue: '   ' })).toEqual(['video']);
  });
});
