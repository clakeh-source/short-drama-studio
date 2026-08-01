import { describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  composeElements,
  MAX_ANGLES_PER_ELEMENT,
  MAX_ELEMENTS,
} from '@/lib/providers/fal/elements';
import type { VideoCastReference } from '@/lib/providers';

/**
 * Turning a shot's cast into Kling `elements`, and its prompt into one that
 * points at them.
 *
 * The element list is mechanical. The prompt rewrite is not: it edits prose a
 * language model wrote, and both failure directions are silent. Miss a name and
 * the character is sent but never referred to; match too eagerly and the
 * sentence is corrupted in a way that only shows up in the finished clip. So
 * most of what follows is about the second kind.
 */

const mei: VideoCastReference = {
  name: 'Mei Lin',
  urls: ['https://s.test/mei/0.png', 'https://s.test/mei/1.png', 'https://s.test/mei/2.png'],
};
const daniel: VideoCastReference = {
  name: 'Daniel Voss',
  urls: ['https://s.test/dan/0.png', 'https://s.test/dan/1.png'],
};

describe('building the elements', () => {
  it('gives each character their own group, best view first', () => {
    const { elements } = composeElements('Mei Lin faces Daniel Voss.', [mei, daniel]);

    expect(elements).toHaveLength(2);
    expect(elements[0]!.frontal_image_url).toBe(mei.urls[0]);
    expect(elements[0]!.reference_image_urls).toEqual(mei.urls.slice(1));
    expect(elements[1]!.frontal_image_url).toBe(daniel.urls[0]);
  });

  it('caps the extra angles at what the field accepts', () => {
    const many = { name: 'Mei Lin', urls: Array.from({ length: 9 }, (_, i) => `https://s.test/${i}.png`) };
    const { elements } = composeElements('Mei Lin waits.', [many]);

    // "1-3 images supported" — sending nine is a rejected request, and the
    // request is rejected as a whole, so this would fail the shot.
    expect(elements[0]!.reference_image_urls).toHaveLength(MAX_ANGLES_PER_ELEMENT);
  });

  it('omits the angles field for a character with a single still', () => {
    const { elements } = composeElements('Mei Lin waits.', [{ name: 'Mei Lin', urls: ['a.png'] }]);

    expect(elements[0]!.frontal_image_url).toBe('a.png');
    expect(elements[0]).not.toHaveProperty('reference_image_urls');
  });

  it('caps the cast, rather than sending a crowd the endpoint refuses', () => {
    const crowd = Array.from({ length: 7 }, (_, i) => ({
      name: `Person${i}`,
      urls: [`https://s.test/${i}.png`],
    }));

    expect(composeElements('A crowd.', crowd).elements).toHaveLength(MAX_ELEMENTS);
  });

  it('drops a character with no stills instead of sending an empty element', () => {
    const { elements, prompt } = composeElements('Mei Lin and Daniel Voss talk.', [
      mei,
      { name: 'Daniel Voss', urls: [] },
    ]);

    expect(elements).toHaveLength(1);
    // And Daniel keeps his name in the prompt, because there is no element for
    // the tag to point at.
    expect(prompt).toContain('Daniel Voss');
  });
});

describe('pointing the prompt at them', () => {
  it('rewrites a name into its position', () => {
    const { prompt } = composeElements('Mei Lin turns from the window.', [mei]);
    expect(prompt).toBe('@Element1 turns from the window.');
  });

  it('numbers by billing order', () => {
    const { prompt } = composeElements('Daniel Voss blocks Mei Lin at the door.', [mei, daniel]);
    // Mei is billed first, so she is @Element1 wherever she appears in the line.
    expect(prompt).toBe('@Element2 blocks @Element1 at the door.');
  });

  it('rewrites every mention, not just the first', () => {
    const { prompt } = composeElements('Mei Lin waits. Rain hits Mei Lin.', [mei]);
    // One tagged reference and one untagged stranger who happens to share a
    // name is not what the sentence means.
    expect(prompt).toBe('@Element1 waits. Rain hits @Element1.');
  });

  it('follows a full name to the bare first name', () => {
    const { prompt } = composeElements('Mei Lin steps back. Mei is shaking.', [mei]);
    expect(prompt).toBe('@Element1 steps back. @Element1 is shaking.');
  });

  it('matches a first name on its own', () => {
    const { prompt, referenced } = composeElements('Mei watches the ferry go.', [mei]);
    expect(prompt).toBe('@Element1 watches the ferry go.');
    expect(referenced).toEqual([true]);
  });

  it('ignores case, because the storyboard shouts its cast', () => {
    // Screenplay convention puts the name in caps on first appearance.
    const { prompt } = composeElements('MEI LIN enters, soaked.', [mei]);
    expect(prompt).toBe('@Element1 enters, soaked.');
  });

  it('keeps possessives readable', () => {
    const { prompt } = composeElements("Mei's hand shakes.", [mei]);
    expect(prompt).toBe("@Element1's hand shakes.");
  });

  it('does not match inside a longer word', () => {
    // The failure this guards is a prompt about a place — Meishan, Danielle —
    // turning into a prompt about a person.
    const { prompt } = composeElements('The Meishan ferry docks.', [mei]);
    expect(prompt).toBe('The Meishan ferry docks. @Element1 is Mei Lin.');
  });

  it('respects word edges in non-Latin scripts', () => {
    // `\b` is ASCII-only and fires in the middle of a name like this, which
    // would leave half a name and half a tag.
    const jose: VideoCastReference = { name: 'José Álvarez', urls: ['https://s.test/j.png'] };
    const { prompt } = composeElements('José Álvarez lights a cigarette.', [jose]);
    expect(prompt).toBe('@Element1 lights a cigarette.');
  });

  it('refuses to guess between two characters sharing a first name', () => {
    const meiChen: VideoCastReference = { name: 'Mei Chen', urls: ['https://s.test/c.png'] };
    const { prompt } = composeElements('Mei Lin nods. Mei looks away.', [mei, meiChen]);

    // The full name is unambiguous and is rewritten; the bare "Mei" could be
    // either woman, and tagging the wrong face is worse than leaving prose
    // alone — it is also the kind of wrong nobody sees until the clip is made.
    expect(prompt).toContain('@Element1 nods.');
    expect(prompt).toContain('Mei looks away.');
  });
});

describe('a character the prompt never names', () => {
  it('introduces them rather than dropping them', () => {
    const { prompt, referenced, introduced } = composeElements(
      'The ferryman waves the last passenger aboard.',
      [{ name: 'Old Wen', urls: ['https://s.test/wen.png'] }],
    );

    // Dropping the element would quietly return this character to being
    // redrawn from scratch in every shot they appear in — the exact failure
    // elements exist to fix.
    expect(prompt).toBe('The ferryman waves the last passenger aboard. @Element1 is Old Wen.');
    expect(referenced).toEqual([false]);
    expect(introduced).toEqual(['Old Wen']);
  });

  it('introduces only the ones it had to', () => {
    const { prompt, introduced } = composeElements('Mei Lin argues with the harbourmaster.', [
      mei,
      { name: 'Old Wen', urls: ['https://s.test/wen.png'] },
    ]);

    expect(prompt).toBe('@Element1 argues with the harbourmaster. @Element2 is Old Wen.');
    expect(introduced).toEqual(['Old Wen']);
  });
});

describe('no cast', () => {
  it('leaves the prompt exactly as written', () => {
    const prompt = 'Rain sheets down the glass of an empty ticket window.';

    // An establishing shot with nobody in it must not acquire trailing machine
    // text, and must not become an image-to-video call by accident.
    expect(composeElements(prompt, [])).toEqual({
      prompt,
      elements: [],
      referenced: [],
      introduced: [],
    });
  });
});

describe('what the configured model can actually do', () => {
  it('knows the generations that read elements', () => {
    // Verified against fal's OpenAPI schema per endpoint. v3 and o1 declare
    // `elements`; nothing before them does.
    expect(capabilitiesFor('fal-ai/kling-video/v3/pro/image-to-video').elements).toBe(true);
    expect(capabilitiesFor('fal-ai/kling-video/o1/reference-to-video').elements).toBe(true);
    expect(capabilitiesFor('fal-ai/kling-video/v2.5-turbo/pro/image-to-video').elements).toBe(false);
    expect(capabilitiesFor('fal-ai/kling-video/v2.1/pro/image-to-video').elements).toBe(false);
    expect(capabilitiesFor('fal-ai/kling-video/v1.6/pro/image-to-video').elements).toBe(false);
  });

  it('knows which field the start frame goes in', () => {
    // The split that made the original bug plausible: `image_url` is correct
    // for pre-v3 and wrong for v3, and the model id is configurable.
    expect(capabilitiesFor('fal-ai/kling-video/v3/pro/image-to-video').startImageField).toBe(
      'start_image_url',
    );
    expect(capabilitiesFor('fal-ai/kling-video/v2.1/pro/image-to-video').startImageField).toBe(
      'image_url',
    );
  });

  it('assumes an unknown model is newer, not older', () => {
    // The alternative silently degrades a capable model to a start frame it
    // cannot read, which is the harder failure to notice of the two.
    expect(capabilitiesFor('fal-ai/kling-video/v4/pro/image-to-video')).toEqual({
      startImageField: 'start_image_url',
      elements: true,
    });
  });

  it('does not read a version out of the middle of a name', () => {
    // Anchored on path segments: `v10` must not match as `v1`, and a customer
    // model called `studio-v2-final` is not a Kling generation.
    expect(capabilitiesFor('fal-ai/kling-video/v10/pro/image-to-video').elements).toBe(true);
    expect(capabilitiesFor('acme/studio-v2-final').elements).toBe(true);
  });
});
