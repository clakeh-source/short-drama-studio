'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders a shot card only once it is near the viewport.
 *
 * A single card is about 8.7 KB of markup — over half of it repeated Tailwind
 * class attributes, plus seven inline SVG icons — so a twenty-shot board shipped
 * roughly 170 KB of cards, and a five-minute episode can hold a hundred. Only
 * four fit on screen at a time. Everything below the fold is paid for and not
 * looked at.
 *
 * **Mount-once, not a sliding window.** A conventional virtual list unmounts rows
 * as they leave the viewport, which would break drag-to-reorder outright: you
 * cannot drop a shot onto a row that does not exist, and this board lets you drag
 * shot 1 to the far end of the episode. Keeping a card mounted after its first
 * appearance costs nothing on load — the payload win is entirely in what is *not*
 * sent initially — and leaves reordering, `j`/`k` navigation, in-page find and
 * every card's expanded state exactly as they were.
 *
 * The placeholder keeps the shot's `data-shot-id` and its drop handlers, so a
 * card that has not mounted yet is still a valid target and still something
 * `scrollIntoView` can find.
 */

/**
 * Reserved height for an unmounted card, matching a collapsed card exactly
 * (measured at 234px). Wrong values here would show up as layout shift the moment
 * a card mounts, so it is a measured constant rather than an estimate.
 */
export const SHOT_CARD_HEIGHT_PX = 234;

/**
 * How many cards are rendered for real before the browser has told us anything.
 *
 * The server has no viewport, and this number is also the client's first render,
 * so the two agree and hydration is clean. Six covers a 908px viewport (four
 * cards) with two to spare; the observer fills in the rest as soon as it runs.
 */
export const INITIALLY_MOUNTED_SHOTS = 6;

/** Mount a card this far before it scrolls into view, so it is never seen popping in. */
const ROOT_MARGIN = '800px 0px';

export interface DeferredShotProps {
  shotId: string;
  /** True for the first few cards, which render immediately on the server. */
  initiallyMounted: boolean;
  /**
   * Forces the card to render regardless of scroll position — used when `j`/`k`
   * moves focus to a shot that has not been scrolled to yet.
   */
  forceMount?: boolean;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  children: React.ReactNode;
}

export function DeferredShot(props: DeferredShotProps) {
  const [mounted, setMounted] = useState(props.initiallyMounted);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mounted) return;
    if (props.forceMount) {
      setMounted(true);
      return;
    }

    const element = ref.current;
    if (!element) return;

    // No IntersectionObserver (jsdom, very old browsers): render everything
    // rather than leave the board permanently blank.
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setMounted(true);
      },
      { rootMargin: ROOT_MARGIN },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, props.forceMount]);

  if (mounted) return <>{props.children}</>;

  return (
    <div
      ref={ref}
      data-shot-id={props.shotId}
      data-placeholder="true"
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      style={{ height: SHOT_CARD_HEIGHT_PX }}
      className={cn('rounded-xl border border-border bg-card/40')}
      aria-hidden="true"
    />
  );
}
