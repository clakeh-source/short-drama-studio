import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFilterGraph,
  DEFAULT_MUSIC_LEVEL_DB,
  musicLevelDb,
} from '@/lib/providers/ffmpeg/render';
import { getRenderProvider, registeredProviderIds } from '@/lib/providers';

/**
 * The ffmpeg adapter's filter graph, asserted without running ffmpeg.
 *
 * The graph is where the spec's encoding requirements actually live — vertical
 * scaling, 30fps, -14 LUFS, burned subtitles — so it is worth pinning
 * independently of whether a binary is installed on the machine.
 */

describe('render provider registry (AC #4)', () => {
  it('registers all three adapters behind one env var', () => {
    expect(registeredProviderIds().render).toEqual(['stub', 'shotstack', 'ffmpeg']);
  });

  it('resolves each by id', () => {
    expect(getRenderProvider('stub').id).toBe('stub');
    expect(getRenderProvider('ffmpeg').id).toBe('ffmpeg');
    // Shotstack construction must not need a key until it is actually called.
    expect(getRenderProvider('shotstack').id).toBe('shotstack');
  });

  it('names the env var when asked for something unknown', () => {
    expect(() => getRenderProvider('premiere')).toThrow(/RENDER_PROVIDER/);
  });

  it('costs nothing to render locally', () => {
    expect(
      getRenderProvider('ffmpeg').estimateCostCents({
        clips: [{ url: 'a', durationSeconds: 5, startAt: 0 }],
        voiceTracks: [],
        captions: [],
        aspectRatio: '9:16',
        resolution: '1080x1920',
      }),
    ).toBe(0);
  });
});

describe('musicLevelDb', () => {
  const original = process.env.MUSIC_BED_LEVEL_DB;
  afterEach(() => {
    if (original === undefined) delete process.env.MUSIC_BED_LEVEL_DB;
    else process.env.MUSIC_BED_LEVEL_DB = original;
  });

  it('defaults to 18dB under the dialogue', () => {
    delete process.env.MUSIC_BED_LEVEL_DB;
    expect(musicLevelDb()).toBe(DEFAULT_MUSIC_LEVEL_DB);
    expect(DEFAULT_MUSIC_LEVEL_DB).toBe(-18);
  });

  it('takes a configured level', () => {
    process.env.MUSIC_BED_LEVEL_DB = '-24';
    expect(musicLevelDb()).toBe(-24);
  });

  it('refuses a positive level rather than clamping it', () => {
    // Above 0dB the bed is louder than the dialogue, which nobody means.
    // Clamping silently would hide the typo.
    process.env.MUSIC_BED_LEVEL_DB = '18';
    expect(() => musicLevelDb()).toThrow(/at or below 0/);

    process.env.MUSIC_BED_LEVEL_DB = 'quiet';
    expect(() => musicLevelDb()).toThrow(/at or below 0/);
  });
});

describe('buildFilterGraph', () => {
  const base = {
    clipCount: 3,
    voice: [] as Array<{ inputIndex: number; startAt: number }>,
    musicInputIndex: null,
    subtitlesFile: null,
    totalSeconds: 15,
  };

  it('scales and crops every clip to the vertical frame', () => {
    const { filter } = buildFilterGraph(base);
    for (let i = 0; i < 3; i++) {
      expect(filter).toContain(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase`);
    }
    expect(filter.match(/crop=1080:1920/g)).toHaveLength(3);
  });

  it('forces 30fps and a common pixel format before concatenating', () => {
    const { filter } = buildFilterGraph(base);
    expect(filter.match(/fps=30/g)).toHaveLength(3);
    expect(filter.match(/format=yuv420p/g)).toHaveLength(3);
    expect(filter).toContain('concat=n=3:v=1:a=0[vcat]');
  });

  it('normalises sample aspect ratio, so mixed sources cut without a jump', () => {
    expect(buildFilterGraph(base).filter.match(/setsar=1/g)).toHaveLength(3);
  });

  it('burns subtitles in when given a file, and maps the filtered stream', () => {
    const graph = buildFilterGraph({ ...base, subtitlesFile: 'captions.ass' });
    expect(graph.filter).toContain('[vcat]subtitles=filename=captions.ass[vsub]');
    expect(graph.videoLabel).toBe('[vsub]');
  });

  it('does not quote the subtitle path', () => {
    // Quotes inside a filter description are eaten by the filtergraph parser
    // before the filter sees them; ffmpeg then reports "No option name near
    // 'captions.ass'" and the whole render fails.
    const graph = buildFilterGraph({ ...base, subtitlesFile: 'captions.ass' });
    expect(graph.filter).not.toContain("subtitles='");
  });

  it('maps the raw concat when there are no captions', () => {
    const graph = buildFilterGraph(base);
    expect(graph.filter).not.toContain('subtitles=');
    expect(graph.videoLabel).toBe('[vcat]');
  });

  it('has no audio output when there is no audio input', () => {
    expect(buildFilterGraph(base).audioLabel).toBeNull();
  });

  it('delays each voice track to its timeline position', () => {
    const graph = buildFilterGraph({
      ...base,
      voice: [
        { inputIndex: 3, startAt: 0 },
        { inputIndex: 4, startAt: 5 },
        { inputIndex: 5, startAt: 10.5 },
      ],
    });

    expect(graph.filter).toContain('[3:a]aresample=48000,adelay=0|0');
    expect(graph.filter).toContain('[4:a]aresample=48000,adelay=5000|5000');
    // Fractional positions round to whole milliseconds.
    expect(graph.filter).toContain('[5:a]aresample=48000,adelay=10500|10500');
  });

  it('normalises to -14 LUFS — the short-form platform target', () => {
    const single = buildFilterGraph({ ...base, voice: [{ inputIndex: 3, startAt: 0 }] });
    expect(single.filter).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    expect(single.audioLabel).toBe('[aout]');
  });

  it('mixes multiple tracks before normalising, not after', () => {
    const graph = buildFilterGraph({
      ...base,
      voice: [
        { inputIndex: 3, startAt: 0 },
        { inputIndex: 4, startAt: 5 },
      ],
    });
    const mixAt = graph.filter.indexOf('amix=inputs=2');
    const normAt = graph.filter.indexOf('loudnorm');
    expect(mixAt).toBeGreaterThan(-1);
    expect(normAt).toBeGreaterThan(mixAt);
  });

  it('ducks the music bed 18dB under the dialogue by default', () => {
    const graph = buildFilterGraph({
      ...base,
      voice: [{ inputIndex: 3, startAt: 0 }],
      musicInputIndex: 4,
    });
    // In dB, not a linear multiplier: it is the unit the requirement is written
    // in and the unit anyone adjusting it thinks in.
    expect(graph.filter).toContain(`volume=${DEFAULT_MUSIC_LEVEL_DB}dB`);
    expect(graph.filter).toContain('amix=inputs=2');
  });

  it('honours a configured music level', () => {
    const graph = buildFilterGraph({
      ...base,
      voice: [{ inputIndex: 3, startAt: 0 }],
      musicInputIndex: 4,
      musicLevelDb: -24,
    });
    expect(graph.filter).toContain('volume=-24dB');
  });

  it('ducks before mixing, so the level is a ratio against the dialogue', () => {
    const graph = buildFilterGraph({
      ...base,
      voice: [{ inputIndex: 3, startAt: 0 }],
      musicInputIndex: 4,
    });
    // Attenuating after the mix would quieten the voice by the same amount and
    // leave the balance between them untouched.
    expect(graph.filter.indexOf('volume=')).toBeLessThan(graph.filter.indexOf('amix='));
  });

  it('mixes music alone when there is no dialogue at all', () => {
    const graph = buildFilterGraph({ ...base, musicInputIndex: 3 });
    expect(graph.audioLabel).toBe('[aout]');
    expect(graph.filter).toContain('loudnorm');
  });

  it('pads every track to the full programme length', () => {
    const graph = buildFilterGraph({
      ...base,
      totalSeconds: 42,
      voice: [{ inputIndex: 3, startAt: 0 }],
    });
    expect(graph.filter).toContain('apad=whole_dur=42');
  });

  it('is deterministic', () => {
    const input = { ...base, voice: [{ inputIndex: 3, startAt: 2.25 }], musicInputIndex: 4 };
    expect(buildFilterGraph(input).filter).toBe(buildFilterGraph(input).filter);
  });
});
