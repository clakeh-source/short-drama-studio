/**
 * Burned-in caption styling and subtitle generation.
 *
 * Pure and dependency-free. Two consumers: the ffmpeg adapter renders the ASS
 * file through the `subtitles` filter, and the cloud adapter maps the same style
 * onto its own caption primitives — so the look is defined once (Phase 4 AC #4).
 *
 * Vertical short drama is watched muted, so captions are not an accessibility
 * afterthought here: they are how most of the audience reads the scene. Hence
 * bold, high contrast, and never inside the platform's UI furniture.
 */

import type { TimelineCaption } from './timeline';

/* -------------------------------------------------------------------------- */
/* Safe areas                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every vertical platform paints its own chrome over the frame: the caption,
 * handle and action rail at the bottom, the status bar and progress indicator at
 * the top. Phase 4 AC #3 requires captions to clear both.
 */
export const BOTTOM_SAFE_FRACTION = 0.12;
export const TOP_SAFE_FRACTION = 0.1;

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;

export const BOTTOM_SAFE_PX = Math.round(FRAME_HEIGHT * BOTTOM_SAFE_FRACTION); // 230
export const TOP_SAFE_PX = Math.round(FRAME_HEIGHT * TOP_SAFE_FRACTION); // 192

/** Vertical band captions may occupy, in pixels from the top of the frame. */
export function captionSafeBand(): { top: number; bottom: number; height: number } {
  const top = TOP_SAFE_PX;
  const bottom = FRAME_HEIGHT - BOTTOM_SAFE_PX;
  return { top, bottom, height: bottom - top };
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

export interface CaptionStyle {
  id: string;
  label: string;
  fontFamily: string;
  fontSizePx: number;
  /** &HAABBGGRR — ASS colours are BGR with an inverted alpha byte. */
  primaryColour: string;
  outlineColour: string;
  backColour: string;
  outlineWidthPx: number;
  shadowPx: number;
  bold: boolean;
  uppercase: boolean;
  /** Distance from the bottom of the frame to the caption baseline. */
  marginBottomPx: number;
  marginSidePx: number;
  /** 3 = opaque box behind the text, 1 = outline only. */
  borderStyle: 1 | 3;
}

/**
 * Margins are measured from the frame edge, so every preset's margin must clear
 * the bottom safe area. Enforced by `assertStyleClearsSafeArea` and asserted in
 * the tests rather than left to whoever adds the next preset.
 */
export const CAPTION_PRESETS: Record<string, CaptionStyle> = {
  'short-drama': {
    id: 'short-drama',
    label: 'Short drama (default)',
    fontFamily: 'Arial Black',
    fontSizePx: 64,
    primaryColour: '&H00FFFFFF', // white
    outlineColour: '&H00000000', // black
    backColour: '&H80000000', // 50% black
    outlineWidthPx: 4,
    shadowPx: 2,
    bold: true,
    uppercase: true,
    marginBottomPx: BOTTOM_SAFE_PX + 60,
    marginSidePx: 80,
    borderStyle: 1,
  },
  boxed: {
    id: 'boxed',
    label: 'Boxed — maximum legibility',
    fontFamily: 'Arial Black',
    fontSizePx: 58,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    outlineWidthPx: 0,
    shadowPx: 0,
    bold: true,
    uppercase: true,
    marginBottomPx: BOTTOM_SAFE_PX + 50,
    marginSidePx: 90,
    borderStyle: 3,
  },
  subtle: {
    id: 'subtle',
    label: 'Subtle — sentence case, thin outline',
    fontFamily: 'Helvetica',
    fontSizePx: 52,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H60000000',
    outlineWidthPx: 2,
    shadowPx: 1,
    bold: false,
    uppercase: false,
    marginBottomPx: BOTTOM_SAFE_PX + 40,
    marginSidePx: 100,
    borderStyle: 1,
  },
};

export const DEFAULT_CAPTION_STYLE_ID = 'short-drama';

export function resolveCaptionStyle(id?: string | null): CaptionStyle {
  return CAPTION_PRESETS[id ?? ''] ?? CAPTION_PRESETS[DEFAULT_CAPTION_STYLE_ID]!;
}

export interface SafeAreaViolation {
  reason: string;
}

/**
 * A style whose text could land inside platform chrome is a bug, not a taste
 * question. Checked before a render rather than discovered on a phone.
 */
export function assertStyleClearsSafeArea(style: CaptionStyle): SafeAreaViolation[] {
  const violations: SafeAreaViolation[] = [];

  if (style.marginBottomPx < BOTTOM_SAFE_PX) {
    violations.push({
      reason:
        `Caption margin of ${style.marginBottomPx}px sits inside the bottom ` +
        `${BOTTOM_SAFE_PX}px safe area, where the platform draws its own UI.`,
    });
  }

  // Two lines of text growing upward from the margin must still clear the top.
  const tallestBlock = style.fontSizePx * 2.4;
  const topOfText = FRAME_HEIGHT - style.marginBottomPx - tallestBlock;
  if (topOfText < TOP_SAFE_PX) {
    violations.push({
      reason:
        `A two-line caption at ${style.fontSizePx}px would reach ${Math.round(topOfText)}px ` +
        `from the top, inside the ${TOP_SAFE_PX}px top safe area.`,
    });
  }

  if (style.marginSidePx < 40) {
    violations.push({ reason: 'Side margin under 40px risks clipping on rounded displays.' });
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* ASS generation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ASS timestamps are H:MM:SS.cc — centiseconds, one leading hour digit.
 *
 * Rounds to centiseconds *first*, then decomposes. Rounding the fractional part
 * separately and carrying into seconds looks equivalent but is not: 59.999s
 * carries to 60 seconds and emits "0:00:60.00", which is not a valid timestamp.
 * Carrying has to propagate through minutes and hours too, and decomposing from
 * a single integer is the only way to get that right for free.
 */
export function toAssTime(seconds: number): string {
  const totalCentis = Math.max(0, Math.round(seconds * 100));

  const hours = Math.floor(totalCentis / 360_000);
  const minutes = Math.floor((totalCentis % 360_000) / 6_000);
  const secs = Math.floor((totalCentis % 6_000) / 100);
  const centis = totalCentis % 100;

  return (
    `${hours}:${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
  );
}

/** Commas and braces are ASS syntax; newlines become the explicit \\N break. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

export function buildAssSubtitles(
  captions: TimelineCaption[],
  style: CaptionStyle = resolveCaptionStyle(),
): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${FRAME_WIDTH}`,
    `PlayResY: ${FRAME_HEIGHT}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      style.fontFamily,
      style.fontSizePx,
      style.primaryColour,
      style.primaryColour,
      style.outlineColour,
      style.backColour,
      style.bold ? -1 : 0,
      0, // italic
      0, // underline
      0, // strikeout
      100, // scaleX
      100, // scaleY
      0, // spacing
      0, // angle
      style.borderStyle,
      style.outlineWidthPx,
      style.shadowPx,
      2, // alignment: bottom-centre
      style.marginSidePx,
      style.marginSidePx,
      style.marginBottomPx,
      1, // encoding
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = captions.map((cue) => {
    const text = escapeAssText(style.uppercase ? cue.text.toUpperCase() : cue.text);
    return `Dialogue: 0,${toAssTime(cue.startAt)},${toAssTime(cue.endAt)},Caption,,0,0,0,,${text}`;
  });

  return [...header, ...events, ''].join('\n');
}

/** SRT timestamps are HH:MM:SS,mmm. Same carry trap as ASS — same fix. */
export function toSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));

  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  );
}

/** SRT, for the cloud adapters that take a subtitle file rather than a style. */
export function buildSrtSubtitles(captions: TimelineCaption[]): string {

  return (
    captions
      .map((cue, i) =>
        [`${i + 1}`, `${toSrtTime(cue.startAt)} --> ${toSrtTime(cue.endAt)}`, cue.text, ''].join(
          '\n',
        ),
      )
      .join('\n') + '\n'
  );
}
