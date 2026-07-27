import { describe, expect, it } from 'vitest';
import {
  CAMERA_VOCABULARY,
  composeImagePrompt,
  composeNegativePrompt,
  composeVideoPrompt,
  DEFAULT_NEGATIVE_PROMPT,
  DEFAULT_STYLE_SUFFIX,
  fallbackAppearance,
  normaliseCamera,
  type PromptCharacter,
} from '@/lib/ai/prompts';

/**
 * Phase 2 AC #2 — composeVideoPrompt is pure, with coverage for a
 * multi-character shot, a no-character insert, a user override, and a missing
 * appearance. AC #3 — a shot containing character X always carries X's
 * appearance_prompt verbatim.
 */

const MARA: PromptCharacter = {
  id: 'c1',
  name: 'Mara Vance',
  role: 'protagonist',
  appearancePrompt:
    'a woman in her late twenties, sharp jawline, dark hair in a low knot, charcoal hotel blazer',
};

const DANE: PromptCharacter = {
  id: 'c2',
  name: 'Dane Ashford',
  role: 'antagonist',
  appearancePrompt:
    'a man in his early thirties, close-cropped black hair, scar through the right eyebrow, navy overcoat',
};

const base = {
  camera: 'close-up',
  action: 'She freezes mid-signature',
  location: 'Hotel lobby, front desk',
  timeOfDay: 'night',
  characters: [] as PromptCharacter[],
  styleSuffix: 'moody teal grade, handheld',
};

describe('normaliseCamera', () => {
  it('passes every vocabulary term through', () => {
    for (const camera of CAMERA_VOCABULARY) {
      expect(normaliseCamera(camera)).toBe(camera);
    }
  });

  it('is case-insensitive and trims', () => {
    expect(normaliseCamera('  CLOSE-UP ')).toBe('close-up');
  });

  it('falls back to medium for anything unrecognised', () => {
    expect(normaliseCamera('dutch angle drone orbit')).toBe('medium');
    expect(normaliseCamera('')).toBe('medium');
    expect(normaliseCamera(null)).toBe('medium');
    expect(normaliseCamera(undefined)).toBe('medium');
  });
});

describe('composeVideoPrompt', () => {
  it('is pure — identical input gives byte-identical output', () => {
    const input = { ...base, characters: [MARA] };
    expect(composeVideoPrompt(input)).toBe(composeVideoPrompt(input));
    expect(composeVideoPrompt({ ...input })).toBe(composeVideoPrompt({ ...input }));
  });

  it('emits segments in the specified order', () => {
    const prompt = composeVideoPrompt({ ...base, characters: [MARA] });

    const camera = prompt.indexOf('close-up shot');
    const appearance = prompt.indexOf(MARA.appearancePrompt);
    const action = prompt.indexOf('She freezes mid-signature');
    const place = prompt.indexOf('Hotel lobby, front desk');
    const style = prompt.indexOf('moody teal grade');

    expect(camera).toBe(0);
    expect(appearance).toBeGreaterThan(camera);
    expect(action).toBeGreaterThan(appearance);
    expect(place).toBeGreaterThan(action);
    expect(style).toBeGreaterThan(place);
  });

  it('multi-character shot: every appearance appears verbatim, in order', () => {
    const prompt = composeVideoPrompt({ ...base, camera: 'over-shoulder', characters: [MARA, DANE] });

    expect(prompt).toContain(MARA.appearancePrompt);
    expect(prompt).toContain(DANE.appearancePrompt);
    expect(prompt.indexOf(MARA.appearancePrompt)).toBeLessThan(
      prompt.indexOf(DANE.appearancePrompt),
    );
    expect(prompt.startsWith('over-shoulder shot,')).toBe(true);
  });

  it('no-character insert shot: no cast, no dangling separators', () => {
    const prompt = composeVideoPrompt({
      ...base,
      camera: 'insert',
      action: 'a fountain pen resting on an open register',
      characters: [],
    });

    expect(prompt).toBe(
      'insert shot, a fountain pen resting on an open register, ' +
        'Hotel lobby, front desk, night, moody teal grade, handheld',
    );
    expect(prompt).not.toMatch(/,\s*,/);
    expect(prompt).not.toMatch(/,\s*$/);
  });

  it('user prompt override wins outright', () => {
    const override = 'anamorphic close-up, rain on glass, single practical light';
    const prompt = composeVideoPrompt({ ...base, characters: [MARA, DANE], override });

    expect(prompt).toBe(override);
    expect(prompt).not.toContain(MARA.appearancePrompt);
    expect(prompt).not.toContain(DEFAULT_STYLE_SUFFIX);
  });

  it('treats a blank override as absent', () => {
    const withBlank = composeVideoPrompt({ ...base, characters: [MARA], override: '   ' });
    const without = composeVideoPrompt({ ...base, characters: [MARA] });
    expect(withBlank).toBe(without);

    expect(composeVideoPrompt({ ...base, characters: [MARA], override: null })).toBe(without);
  });

  it('missing appearance falls back to a role-derived descriptor', () => {
    const nameless: PromptCharacter = {
      id: 'c3',
      name: 'Iris Calloway',
      role: 'ally',
      appearancePrompt: '',
    };
    const prompt = composeVideoPrompt({ ...base, characters: [nameless] });

    expect(prompt).toContain(fallbackAppearance(nameless));
    expect(prompt).toContain('an adult ally');
    // Never leaks the character's name into the visual description.
    expect(prompt).not.toContain('Iris');
  });

  it('falls back without a role too', () => {
    const bare: PromptCharacter = { id: 'c4', name: 'Extra', appearancePrompt: '  ' };
    expect(composeVideoPrompt({ ...base, characters: [bare] })).toContain('an adult character');
  });

  it('uses the default style suffix when the series has none', () => {
    expect(composeVideoPrompt({ ...base, characters: [MARA], styleSuffix: null })).toContain(
      DEFAULT_STYLE_SUFFIX,
    );
    expect(composeVideoPrompt({ ...base, characters: [MARA], styleSuffix: '   ' })).toContain(
      DEFAULT_STYLE_SUFFIX,
    );
  });

  it('normalises an unknown camera rather than emitting it', () => {
    const prompt = composeVideoPrompt({ ...base, camera: 'crash zoom', characters: [] });
    expect(prompt.startsWith('medium shot,')).toBe(true);
    expect(prompt).not.toContain('crash zoom');
  });

  it('collapses whitespace and strips trailing punctuation from each segment', () => {
    const prompt = composeVideoPrompt({
      ...base,
      action: '  She   freezes.  ',
      location: 'Lobby,',
      timeOfDay: ' night ',
      characters: [],
    });
    expect(prompt).toContain('She freezes,');
    expect(prompt).not.toContain('  ');
  });

  it('AC #3 — every character in the shot contributes their appearance verbatim', () => {
    const cast = [MARA, DANE];
    for (const camera of CAMERA_VOCABULARY) {
      for (const subset of [[MARA], [DANE], cast]) {
        const prompt = composeVideoPrompt({ ...base, camera, characters: subset });
        for (const character of subset) {
          expect(
            prompt,
            `${camera} with ${character.name}`,
          ).toContain(character.appearancePrompt);
        }
      }
    }
  });
});

describe('composeNegativePrompt', () => {
  it('returns the defaults', () => {
    expect(composeNegativePrompt()).toBe(DEFAULT_NEGATIVE_PROMPT);
  });

  it('appends series-level extras', () => {
    expect(composeNegativePrompt({ extra: 'snow, daylight' })).toBe(
      `${DEFAULT_NEGATIVE_PROMPT}, snow, daylight`,
    );
  });

  it('lets an override replace the defaults entirely', () => {
    expect(composeNegativePrompt({ override: 'text, logo' })).toBe('text, logo');
  });
});

describe('composeImagePrompt', () => {
  it('matches the video prompt plus a still-frame qualifier', () => {
    const input = { ...base, characters: [MARA] };
    expect(composeImagePrompt(input)).toBe(
      `${composeVideoPrompt(input)}, single frame, no motion blur`,
    );
  });

  it('honours an override without appending anything', () => {
    expect(composeImagePrompt({ ...base, override: 'a hand on a brass key' })).toBe(
      'a hand on a brass key',
    );
  });
});
