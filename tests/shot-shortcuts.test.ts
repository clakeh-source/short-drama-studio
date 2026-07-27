import { describe, expect, it } from 'vitest';
import { resolveShortcut, type ShortcutInput } from '@/components/storyboard/use-shot-shortcuts';

const base: ShortcutInput = {
  key: 'j',
  isTyping: false,
  hasModifier: false,
  currentIndex: -1,
  count: 20,
};

const at = (over: Partial<ShortcutInput>) => resolveShortcut({ ...base, ...over });

describe('storyboard shortcuts', () => {
  describe('navigation', () => {
    it('j moves down, k moves up', () => {
      expect(at({ key: 'j', currentIndex: 5 })).toEqual({ type: 'focus', index: 6 });
      expect(at({ key: 'k', currentIndex: 5 })).toEqual({ type: 'focus', index: 4 });
    });

    it('starts at the top for j and the bottom for k when nothing is focused', () => {
      expect(at({ key: 'j', currentIndex: -1 })).toEqual({ type: 'focus', index: 0 });
      expect(at({ key: 'k', currentIndex: -1 })).toEqual({ type: 'focus', index: 19 });
    });

    it('clamps at both ends rather than wrapping', () => {
      expect(at({ key: 'k', currentIndex: 0 })).toEqual({ type: 'focus', index: 0 });
      expect(at({ key: 'j', currentIndex: 19 })).toEqual({ type: 'focus', index: 19 });
    });

    it('does nothing on an empty board', () => {
      expect(at({ key: 'j', count: 0 })).toEqual({ type: 'none' });
    });
  });

  describe('actions', () => {
    it('r regenerates and d duplicates the focused shot', () => {
      expect(at({ key: 'r', currentIndex: 3 })).toEqual({ type: 'regenerate' });
      expect(at({ key: 'd', currentIndex: 3 })).toEqual({ type: 'duplicate' });
    });

    it('needs a focused shot first — r and d are no-ops otherwise', () => {
      expect(at({ key: 'r', currentIndex: -1 })).toEqual({ type: 'none' });
      expect(at({ key: 'd', currentIndex: -1 })).toEqual({ type: 'none' });
    });
  });

  /**
   * The guard that matters most. Every shot card is a form, so without it, typing
   * "dread" into an action field would duplicate the shot twice and queue a
   * regeneration — destructive and expensive, from ordinary typing.
   */
  describe('while typing', () => {
    it('ignores every shortcut', () => {
      for (const key of ['j', 'k', 'r', 'd']) {
        expect(at({ key, isTyping: true, currentIndex: 3 }), key).toEqual({ type: 'none' });
      }
    });

    it('would otherwise have fired — proving the guard is what stops it', () => {
      expect(at({ key: 'd', isTyping: false, currentIndex: 3 })).toEqual({ type: 'duplicate' });
    });
  });

  describe('modifiers', () => {
    it('leaves browser and OS combinations alone', () => {
      // Cmd-R is reload; Cmd-D is bookmark. Neither may be hijacked.
      expect(at({ key: 'r', hasModifier: true, currentIndex: 3 })).toEqual({ type: 'none' });
      expect(at({ key: 'd', hasModifier: true, currentIndex: 3 })).toEqual({ type: 'none' });
      expect(at({ key: 'j', hasModifier: true, currentIndex: 3 })).toEqual({ type: 'none' });
    });
  });

  describe('other keys', () => {
    it('ignores anything unbound', () => {
      for (const key of ['a', 'Enter', 'ArrowDown', ' ', 'Escape']) {
        expect(at({ key, currentIndex: 3 }), key).toEqual({ type: 'none' });
      }
    });

    it('accepts upper case, so Shift does not break the shortcuts', () => {
      expect(at({ key: 'J', currentIndex: 1 })).toEqual({ type: 'focus', index: 2 });
      expect(at({ key: 'D', currentIndex: 1 })).toEqual({ type: 'duplicate' });
    });
  });
});
