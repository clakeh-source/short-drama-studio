import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTtsProvider } from '@/lib/providers';
import { ElevenLabsTtsProvider, wordsFromAlignment } from '@/lib/providers/elevenlabs/tts';
import { assignDefaultVoices } from '@/lib/voices';

const originalEnv = { ...process.env };

function mockFetch(response: { ok?: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: async () => response.body,
        text: async () => JSON.stringify(response.body),
      };
    }),
  );

  return calls;
}

/**
 * Alignment for "Hi there." — one entry per character, whitespace included,
 * which is exactly what the API returns.
 */
const alignment = {
  characters: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e', '.'],
  character_start_times_seconds: [0.0, 0.1, 0.2, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75],
  character_end_times_seconds: [0.1, 0.2, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.9],
};

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = 'xi_test';
  delete process.env.ELEVENLABS_CENTS_PER_1K_CHARS;
  delete process.env.ELEVENLABS_OUTPUT_FORMAT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('elevenlabs registration', () => {
  it('resolves from TTS_PROVIDER without needing a key at construction', () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect(getTtsProvider('elevenlabs').id).toBe('elevenlabs');
  });

  it('names the missing env var when it is not configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(
      new ElevenLabsTtsProvider().synthesize({ text: 'hi', voiceId: 'v1' }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe('cost', () => {
  it('prices per 1k characters at the plan rate', () => {
    const provider = new ElevenLabsTtsProvider();
    expect(provider.estimateCostCents('a'.repeat(1000))).toBe(3);
    // Any non-empty line rounds up to at least a cent, as elsewhere in the app.
    expect(provider.estimateCostCents('short')).toBe(1);
    expect(provider.estimateCostCents('')).toBe(0);

    process.env.ELEVENLABS_CENTS_PER_1K_CHARS = '2.2';
    expect(new ElevenLabsTtsProvider().estimateCostCents('a'.repeat(1000))).toBe(3);
    expect(new ElevenLabsTtsProvider().estimateCostCents('a'.repeat(10_000))).toBe(22);
  });

  it('rejects a nonsense rate rather than charging the default silently', () => {
    process.env.ELEVENLABS_CENTS_PER_1K_CHARS = '-1';
    expect(() => new ElevenLabsTtsProvider().estimateCostCents('hi')).toThrow(
      /ELEVENLABS_CENTS_PER_1K_CHARS/,
    );
  });
});

describe('synthesize', () => {
  it('requests WAV from the with-timestamps endpoint and returns decoded bytes', async () => {
    const audio = Buffer.from('RIFF....WAVEfake');
    const calls = mockFetch({
      body: { audio_base64: audio.toString('base64'), alignment },
    });

    const result = await new ElevenLabsTtsProvider().synthesize({
      text: 'Hi there.',
      voiceId: 'voice_1',
    });

    expect(calls[0]!.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice_1/with-timestamps?output_format=wav_24000',
    );
    expect(calls[0]!.init?.headers).toMatchObject({ 'xi-api-key': 'xi_test' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      text: 'Hi there.',
      model_id: 'eleven_multilingual_v2',
    });

    // Real bytes, and a WAV container — generate-shot-voice stores them as audio/wav.
    expect(result.audio.subarray(0, 4).toString()).toBe('RIFF');
  });

  it('measures the duration from the alignment rather than guessing it', async () => {
    mockFetch({ body: { audio_base64: 'AAAA', alignment } });

    const { durationSeconds } = await new ElevenLabsTtsProvider().synthesize({
      text: 'Hi there.',
      voiceId: 'voice_1',
    });

    expect(durationSeconds).toBe(0.9);
  });

  it('returns per-word timings, which the timeline prefers over its approximation', async () => {
    mockFetch({ body: { audio_base64: 'AAAA', alignment } });

    const { words } = await new ElevenLabsTtsProvider().synthesize({
      text: 'Hi there.',
      voiceId: 'voice_1',
    });

    expect(words).toEqual([
      { word: 'Hi', startSeconds: 0, endSeconds: 0.2 },
      { word: 'there.', startSeconds: 0.25, endSeconds: 0.9 },
    ]);
  });

  it('fails loudly when there is no alignment to measure', async () => {
    // A silently-zero duration would make the voice look like it fits any shot,
    // defeating the overrun check the editor relies on.
    mockFetch({ body: { audio_base64: 'AAAA' } });

    await expect(
      new ElevenLabsTtsProvider().synthesize({ text: 'Hi', voiceId: 'voice_1' }),
    ).rejects.toThrow(/duration cannot be measured/);
  });

  it('surfaces the API error body', async () => {
    mockFetch({ ok: false, status: 401, body: { detail: 'invalid api key' } });

    await expect(
      new ElevenLabsTtsProvider().synthesize({ text: 'Hi', voiceId: 'voice_1' }),
    ).rejects.toThrow(/401.*invalid api key/);
  });

  it('classifies a refusal so the voice job does not retry what cannot succeed', async () => {
    // A revoked key or a voice that no longer exists refuses identically every
    // time; a rate limit does not.
    mockFetch({ ok: false, status: 401, body: {} });
    await expect(
      new ElevenLabsTtsProvider().synthesize({ text: 'Hi', voiceId: 'v1' }),
    ).rejects.toMatchObject({ name: 'ProviderRequestError', retryable: false, status: 401 });

    mockFetch({ ok: false, status: 429, body: {} });
    await expect(
      new ElevenLabsTtsProvider().synthesize({ text: 'Hi', voiceId: 'v1' }),
    ).rejects.toMatchObject({ name: 'ProviderRequestError', retryable: true });
  });

  it('honours a configured output format', async () => {
    process.env.ELEVENLABS_OUTPUT_FORMAT = 'wav_16000';
    const calls = mockFetch({ body: { audio_base64: 'AAAA', alignment } });

    await new ElevenLabsTtsProvider().synthesize({ text: 'Hi there.', voiceId: 'voice_1' });

    expect(calls[0]!.url).toContain('output_format=wav_16000');
  });
});

describe('alignment parsing', () => {
  it('splits on whitespace and keeps punctuation with its word', () => {
    expect(wordsFromAlignment(alignment)).toHaveLength(2);
  });

  it('returns nothing rather than throwing on partial or absent alignment', () => {
    expect(wordsFromAlignment(undefined)).toEqual([]);
    expect(wordsFromAlignment({ characters: ['a'] })).toEqual([]);
  });

  it('ignores runs of whitespace instead of emitting empty words', () => {
    expect(
      wordsFromAlignment({
        characters: ['a', ' ', ' ', 'b'],
        character_start_times_seconds: [0, 1, 2, 3],
        character_end_times_seconds: [1, 2, 3, 4],
      }),
    ).toEqual([
      { word: 'a', startSeconds: 0, endSeconds: 1 },
      { word: 'b', startSeconds: 3, endSeconds: 4 },
    ]);
  });
});

describe('listVoices', () => {
  it('maps the catalogue into the shape the voice picker scores against', async () => {
    mockFetch({
      body: {
        voices: [
          {
            voice_id: 'v_warm',
            name: 'Mara',
            category: 'premade',
            labels: { age: 'young', description: 'warm', use_case: 'narration', gender: 'female' },
          },
          { voice_id: 'v_cold', name: 'Vex', category: 'premade', labels: { age: 'middle_aged' } },
          // No id — unusable, and must not become a voice with an undefined id.
          { name: 'Broken' },
        ],
      },
    });

    const voices = await new ElevenLabsTtsProvider().listVoices();

    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: 'v_warm',
      name: 'Mara',
      // Label *values*, which is what assignDefaultVoices matches on.
      tags: ['young', 'warm', 'narration', 'female', 'premade'],
    });
    // "middle_aged" is split so each half is matchable on its own.
    expect(voices[1]!.tags).toContain('middle');
  });

  it('produces tags the default voice assignment can actually use', async () => {
    mockFetch({
      body: {
        voices: [
          { voice_id: 'v_warm', name: 'Mara', labels: { description: 'warm', age: 'young' } },
          { voice_id: 'v_cold', name: 'Vex', labels: { description: 'cold', age: 'mature' } },
        ],
      },
    });

    const voices = await new ElevenLabsTtsProvider().listVoices();
    const cast = [
      { name: 'Ada', role: 'protagonist' },
      { name: 'Rook', role: 'antagonist' },
    ];

    // The protagonist wants warm/young, the antagonist cold/mature — the
    // catalogue has one of each, so they must not both land on the same voice.
    const assignment = assignDefaultVoices(cast, voices);
    expect(assignment.get('Ada')).toBe('v_warm');
    expect(assignment.get('Rook')).toBe('v_cold');
  });

  it('surfaces a failed catalogue fetch', async () => {
    mockFetch({ ok: false, status: 500, body: {} });
    await expect(new ElevenLabsTtsProvider().listVoices()).rejects.toThrow(/voice list failed/);
  });
});
