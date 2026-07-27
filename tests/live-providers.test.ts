import { describe, expect, it } from 'vitest';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';
import { assignDefaultVoices } from '@/lib/voices';

/**
 * The Phase 6 adapters against the real services.
 *
 * THIS SUITE SPENDS MONEY, so each half is gated separately — voice is cents,
 * video is not, and there is no reason to pay for both to check one:
 *
 *   RUN_LIVE_TTS=1   pnpm test tests/live-providers.test.ts
 *   RUN_LIVE_VIDEO=1 pnpm test tests/live-providers.test.ts
 *
 * What these cover that `tests/elevenlabs-tts.test.ts` and
 * `tests/replicate-video.test.ts` cannot: those mock `fetch`, so they pin what
 * the adapter *sends* and how it reads a response we wrote ourselves. Only a
 * live call proves the field names are right, the auth header is the one the
 * service wants, and the response really has the shape the code destructures.
 */

const liveTts = process.env.RUN_LIVE_TTS === '1' && Boolean(process.env.ELEVENLABS_API_KEY);
const liveVideo = process.env.RUN_LIVE_VIDEO === '1' && Boolean(process.env.REPLICATE_API_TOKEN);

/** Short on purpose: billed per character. */
const LINE = 'You told me he was dead.';

describe.skipIf(!liveTts).sequential('live ElevenLabs', () => {
  const provider = getTtsProvider('elevenlabs');

  it('lists a usable voice catalogue', async () => {
    const voices = await provider.listVoices();

    expect(voices.length).toBeGreaterThan(0);
    for (const voice of voices) {
      expect(voice.id, 'every voice needs an id to be assignable').toBeTruthy();
      expect(voice.name).toBeTruthy();
      expect(Array.isArray(voice.tags)).toBe(true);
    }

    // The catalogue has to be rich enough for the picker to tell a lead from a
    // villain, which is the whole reason tags are mapped from label *values*.
    expect(voices.some((v) => v.tags.length > 0)).toBe(true);
  });

  it('casts a two-hander onto two different voices', async () => {
    const voices = await provider.listVoices();
    const assignment = assignDefaultVoices(
      [
        { name: 'Ada', role: 'protagonist' },
        { name: 'Rook', role: 'antagonist' },
      ],
      voices,
    );

    expect(assignment.size).toBe(2);
    expect(new Set(assignment.values()).size, 'a two-hander must not share one voice').toBe(2);
  });

  it('synthesises real WAV audio with a measured duration and word alignment', async () => {
    const voices = await provider.listVoices();
    const voiceId = voices[0]!.id;

    const { audio, durationSeconds, words } = await provider.synthesize({
      text: LINE,
      voiceId,
    });

    // A WAV container, because generate-shot-voice stores these bytes as audio/wav.
    expect(audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(audio.subarray(8, 12).toString()).toBe('WAVE');
    expect(audio.byteLength).toBeGreaterThan(1000);

    // Six short words: plausibly between half a second and ten.
    expect(durationSeconds).toBeGreaterThan(0.5);
    expect(durationSeconds).toBeLessThan(10);

    // The alignment is the point of using /with-timestamps at all.
    expect(words, 'no alignment came back').toBeDefined();
    expect(words!.length).toBe(LINE.split(/\s+/).length);
    expect(words!.map((w) => w.word).join(' ')).toBe(LINE);

    // Monotonic, and inside the clip.
    let previousEnd = 0;
    for (const word of words!) {
      expect(word.startSeconds).toBeGreaterThanOrEqual(previousEnd - 0.001);
      expect(word.endSeconds).toBeGreaterThanOrEqual(word.startSeconds);
      previousEnd = word.endSeconds;
    }
    expect(previousEnd).toBeLessThanOrEqual(durationSeconds + 0.001);
  });

  it('rejects an unknown voice id with a usable message', async () => {
    await expect(
      provider.synthesize({ text: 'hello', voiceId: 'definitely-not-a-voice' }),
    ).rejects.toThrow(/ElevenLabs refused the synthesis/);
  });
});

describe.skipIf(!liveVideo).sequential('live Replicate', () => {
  const provider = getVideoProvider('replicate');

  it('submits one shot and polls it to a playable clip', async () => {
    const { providerJobId } = await provider.generate({
      prompt:
        'close-up, a woman in a red coat turns to face the camera, rain-slick alley at night, cinematic',
      durationSeconds: 5,
      aspectRatio: '9:16',
    });

    expect(providerJobId).toBeTruthy();

    // Real generation takes minutes; poll on a fixed ceiling rather than forever.
    const deadline = Date.now() + 10 * 60_000;
    let result = await provider.poll(providerJobId);

    while (result.status === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      result = await provider.poll(providerJobId);
    }

    expect(result.status, `prediction did not finish: ${JSON.stringify(result)}`).toBe('ready');
    if (result.status === 'ready') {
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.costCents).toBeGreaterThan(0);

      // The URL has to be fetchable — that is what ingestFromUrl will do next.
      const head = await fetch(result.url, { method: 'HEAD' });
      expect(head.ok).toBe(true);
      expect(head.headers.get('content-type')).toMatch(/video|octet-stream/);
    }
  }, 11 * 60_000);
});
