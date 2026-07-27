import { describe, expect, it } from 'vitest';
import {
  assertStyleClearsSafeArea,
  BOTTOM_SAFE_FRACTION,
  BOTTOM_SAFE_PX,
  buildAssSubtitles,
  buildSrtSubtitles,
  captionSafeBand,
  CAPTION_PRESETS,
  DEFAULT_CAPTION_STYLE_ID,
  escapeAssText,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  resolveCaptionStyle,
  toAssTime,
  toSrtTime,
  TOP_SAFE_FRACTION,
  TOP_SAFE_PX,
} from '@/lib/captions';
import type { TimelineCaption } from '@/lib/timeline';

/**
 * Phase 4 AC #3 — captions burned in, readable, and never overlapping the
 * bottom 12% or top 10% safe areas.
 *
 * The safe-area part is asserted for every preset, so adding a fourth one with a
 * careless margin fails here rather than on someone's phone.
 */

const cues: TimelineCaption[] = [
  { shotId: 's1', text: 'You died in March.', startAt: 0, endAt: 2 },
  { shotId: 's1', text: 'I got better.', startAt: 2.5, endAt: 4.25 },
  { shotId: 's2', text: 'Your name is on it too.', startAt: 61.5, endAt: 64.125 },
];

describe('safe areas', () => {
  it('matches the platform figures the spec names', () => {
    expect(BOTTOM_SAFE_FRACTION).toBe(0.12);
    expect(TOP_SAFE_FRACTION).toBe(0.1);
    expect(BOTTOM_SAFE_PX).toBe(230); // 12% of 1920
    expect(TOP_SAFE_PX).toBe(192); // 10% of 1920
  });

  it('describes the band captions may occupy', () => {
    const band = captionSafeBand();
    expect(band.top).toBe(192);
    expect(band.bottom).toBe(1690);
    expect(band.height).toBe(1498);
  });

  it('AC #3 — every shipped preset clears both safe areas', () => {
    for (const [id, style] of Object.entries(CAPTION_PRESETS)) {
      const violations = assertStyleClearsSafeArea(style);
      expect(violations, `${id}: ${violations.map((v) => v.reason).join('; ')}`).toEqual([]);
    }
  });

  it('every preset sits comfortably above the bottom safe area', () => {
    for (const style of Object.values(CAPTION_PRESETS)) {
      expect(style.marginBottomPx).toBeGreaterThan(BOTTOM_SAFE_PX);
    }
  });

  it('rejects a margin inside the bottom safe area', () => {
    const bad = { ...CAPTION_PRESETS[DEFAULT_CAPTION_STYLE_ID]!, marginBottomPx: 100 };
    const violations = assertStyleClearsSafeArea(bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.reason).toMatch(/bottom/i);
  });

  it('rejects text so large that two lines would reach the top safe area', () => {
    const bad = {
      ...CAPTION_PRESETS[DEFAULT_CAPTION_STYLE_ID]!,
      fontSizePx: 600,
      marginBottomPx: 300,
    };
    expect(assertStyleClearsSafeArea(bad).some((v) => /top/i.test(v.reason))).toBe(true);
  });

  it('rejects side margins that could clip on a rounded display', () => {
    const bad = { ...CAPTION_PRESETS[DEFAULT_CAPTION_STYLE_ID]!, marginSidePx: 10 };
    expect(assertStyleClearsSafeArea(bad).some((v) => /side/i.test(v.reason))).toBe(true);
  });
});

describe('preset resolution', () => {
  it('falls back to the default for anything unknown', () => {
    expect(resolveCaptionStyle('does-not-exist').id).toBe(DEFAULT_CAPTION_STYLE_ID);
    expect(resolveCaptionStyle(null).id).toBe(DEFAULT_CAPTION_STYLE_ID);
    expect(resolveCaptionStyle(undefined).id).toBe(DEFAULT_CAPTION_STYLE_ID);
  });

  it('returns a named preset', () => {
    expect(resolveCaptionStyle('boxed').id).toBe('boxed');
  });

  it('defaults to a bold, high-contrast style, as the format wants', () => {
    const style = resolveCaptionStyle();
    expect(style.bold).toBe(true);
    expect(style.primaryColour).toBe('&H00FFFFFF'); // white
    // Either an outline or an opaque box — never bare white on bright video.
    expect(style.outlineWidthPx > 0 || style.borderStyle === 3).toBe(true);
  });
});

describe('toAssTime', () => {
  it('formats H:MM:SS.cc', () => {
    expect(toAssTime(0)).toBe('0:00:00.00');
    expect(toAssTime(2.5)).toBe('0:00:02.50');
    expect(toAssTime(61.5)).toBe('0:01:01.50');
    expect(toAssTime(3661.25)).toBe('1:01:01.25');
  });

  it('normalises a centisecond carry rather than emitting .100', () => {
    expect(toAssTime(1.999)).toBe('0:00:02.00');
    expect(toAssTime(59.999)).toBe('0:01:00.00');
  });

  it('clamps a negative time', () => {
    expect(toAssTime(-5)).toBe('0:00:00.00');
  });
});

describe('escapeAssText', () => {
  it('neutralises ASS override braces', () => {
    expect(escapeAssText('{\\b1}bold')).not.toContain('{');
  });

  it('turns newlines into the ASS line break', () => {
    expect(escapeAssText('one\ntwo')).toBe('one\\Ntwo');
    expect(escapeAssText('one\r\ntwo')).toBe('one\\Ntwo');
  });
});

describe('buildAssSubtitles', () => {
  const ass = buildAssSubtitles(cues);

  it('declares the vertical frame so margins scale correctly', () => {
    expect(ass).toContain(`PlayResX: ${FRAME_WIDTH}`);
    expect(ass).toContain(`PlayResY: ${FRAME_HEIGHT}`);
    expect(FRAME_WIDTH).toBe(1080);
    expect(FRAME_HEIGHT).toBe(1920);
  });

  it('emits one Dialogue line per cue, in order', () => {
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('0:00:00.00');
    expect(lines[2]).toContain('0:01:01.50');
  });

  it('carries the safe-area margin into the style', () => {
    const style = resolveCaptionStyle();
    expect(ass).toContain(`,${style.marginBottomPx},`);
  });

  it('uppercases when the preset asks for it', () => {
    expect(buildAssSubtitles(cues, resolveCaptionStyle('short-drama'))).toContain(
      'YOU DIED IN MARCH.',
    );
    expect(buildAssSubtitles(cues, resolveCaptionStyle('subtle'))).toContain('You died in March.');
  });

  it('uses bottom-centre alignment', () => {
    // Field 19 of the Style line is Alignment; 2 is bottom-centre.
    const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Caption'))!;
    expect(styleLine.split(',')[18]).toBe('2');
  });

  it('produces a parseable file for an empty cue list', () => {
    const empty = buildAssSubtitles([]);
    expect(empty).toContain('[Events]');
    expect(empty.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0);
  });
});

describe('buildSrtSubtitles', () => {
  const srt = buildSrtSubtitles(cues);

  it('numbers cues from 1 and uses comma milliseconds', () => {
    expect(srt.startsWith('1\n')).toBe(true);
    expect(srt).toContain('00:00:00,000 --> 00:00:02,000');
    expect(srt).toContain('00:01:01,500 --> 00:01:04,125');
  });

  it('keeps the original casing — styling is the renderer’s job here', () => {
    expect(srt).toContain('You died in March.');
  });
});

describe('toSrtTime', () => {
  it('formats HH:MM:SS,mmm', () => {
    expect(toSrtTime(0)).toBe('00:00:00,000');
    expect(toSrtTime(64.125)).toBe('00:01:04,125');
    expect(toSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('propagates a millisecond carry through minutes and hours', () => {
    expect(toSrtTime(59.9999)).toBe('00:01:00,000');
    expect(toSrtTime(3599.9999)).toBe('01:00:00,000');
  });
});

describe('timestamp carry, both formats', () => {
  it('never emits an out-of-range field', () => {
    // Walk the boundaries where a naive carry produces :60 or .100
    for (const seconds of [0.999, 1.999, 59.999, 59.9999, 119.999, 3599.999, 3599.9999]) {
      const ass = toAssTime(seconds);
      const [, mm, rest] = ass.split(':');
      const [ss, cc] = rest!.split('.');
      expect(Number(mm), `ass minutes for ${seconds}`).toBeLessThan(60);
      expect(Number(ss), `ass seconds for ${seconds}`).toBeLessThan(60);
      expect(Number(cc), `ass centis for ${seconds}`).toBeLessThan(100);

      const srt = toSrtTime(seconds);
      const [, sm, srest] = srt.split(':');
      const [ss2, mmm] = srest!.split(',');
      expect(Number(sm), `srt minutes for ${seconds}`).toBeLessThan(60);
      expect(Number(ss2), `srt seconds for ${seconds}`).toBeLessThan(60);
      expect(Number(mmm), `srt millis for ${seconds}`).toBeLessThan(1000);
    }
  });
});
