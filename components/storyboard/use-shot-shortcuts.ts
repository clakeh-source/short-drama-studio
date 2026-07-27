'use client';

import { useEffect } from 'react';

/**
 * Keyboard navigation for the storyboard: `j`/`k` to move between shots, `r` to
 * regenerate the focused shot, `d` to duplicate it.
 *
 * Two rules shape this:
 *
 * 1. **Never fire while the user is typing.** Every shot card is a form — action,
 *    dialogue, duration, prompt override. Without the guard, typing "dread" into
 *    an action field would duplicate the shot twice and queue a regeneration.
 * 2. **A single keystroke must not spend money.** `r` is wired to *ask*, not to
 *    generate; the caller opens a confirmation showing the estimate, matching the
 *    rule that every generate action is explicit and priced first.
 *
 * The decision is a pure function so both rules are testable without a DOM.
 */

export type ShortcutAction =
  | { type: 'none' }
  | { type: 'focus'; index: number }
  | { type: 'regenerate' }
  | { type: 'duplicate' };

export interface ShortcutInput {
  key: string;
  /** True when the keystroke belongs to whatever the user is editing. */
  isTyping: boolean;
  /** True when any of meta/ctrl/alt is held — those belong to the browser and OS. */
  hasModifier: boolean;
  /** Index of the focused shot, or -1 for none. */
  currentIndex: number;
  count: number;
}

export function resolveShortcut(input: ShortcutInput): ShortcutAction {
  const { isTyping, hasModifier, currentIndex, count } = input;
  if (isTyping || hasModifier || count === 0) return { type: 'none' };

  const key = input.key.toLowerCase();

  if (key === 'j' || key === 'k') {
    // From nothing, `j` starts at the top and `k` at the bottom.
    if (currentIndex === -1) return { type: 'focus', index: key === 'j' ? 0 : count - 1 };
    // Clamped rather than wrapped: wrapping from the last shot to the first while
    // scanning a long board is disorienting.
    const next = Math.min(count - 1, Math.max(0, currentIndex + (key === 'j' ? 1 : -1)));
    return { type: 'focus', index: next };
  }

  // `r` and `d` act on a shot, so they need one focused first.
  if (currentIndex === -1) return { type: 'none' };
  if (key === 'r') return { type: 'regenerate' };
  if (key === 'd') return { type: 'duplicate' };

  return { type: 'none' };
}

/** True when the keystroke belongs to whatever the user is editing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}

export interface ShotShortcutHandlers {
  /** Ordered shot ids, as displayed, flattened across scenes. */
  shotIds: string[];
  focusedShotId: string | null;
  onFocus: (shotId: string) => void;
  /** Called with the shot to regenerate — expected to confirm, not to spend. */
  onRequestRegenerate: (shotId: string) => void;
  onDuplicate: (shotId: string) => void;
  /** Suspends the shortcuts, e.g. while a confirmation is open. */
  disabled?: boolean;
}

export function useShotShortcuts(handlers: ShotShortcutHandlers): void {
  const { shotIds, focusedShotId, onFocus, onRequestRegenerate, onDuplicate, disabled } = handlers;

  useEffect(() => {
    if (disabled || shotIds.length === 0) return;

    function onKeyDown(event: KeyboardEvent) {
      const currentIndex = focusedShotId ? shotIds.indexOf(focusedShotId) : -1;

      const action = resolveShortcut({
        key: event.key,
        isTyping: isTypingTarget(event.target),
        hasModifier: event.metaKey || event.ctrlKey || event.altKey,
        currentIndex,
        count: shotIds.length,
      });

      if (action.type === 'none') return;
      event.preventDefault();

      if (action.type === 'focus') onFocus(shotIds[action.index]!);
      else if (action.type === 'regenerate') onRequestRegenerate(shotIds[currentIndex]!);
      else onDuplicate(shotIds[currentIndex]!);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shotIds, focusedShotId, onFocus, onRequestRegenerate, onDuplicate, disabled]);
}
