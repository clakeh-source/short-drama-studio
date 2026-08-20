import { configurationError, isRetryableStatus, ProviderRequestError } from '../types';
import type { TtsProvider, TtsResult, TtsWordTiming } from '../types';

/**
 * ElevenLabs TTS adapter.
 *
 * Two choices here are load-bearing.
 *
 * **The `with-timestamps` endpoint, not plain synthesis.** It costs the same and
 * returns per-character alignment alongside the audio. `TtsWordTiming` has
 * existed on the provider interface since Phase 0 and `lib/timeline.ts` already
 * prefers real alignment over its length-proportional approximation — no
 * provider had ever filled it in. Captions land on the actual word here.
 *
 * **WAV output, not the default MP3.** `generate-shot-voice.ts` uploads the
 * bytes as `audio/wav`, and a measured duration is required rather than nice to
 * have. Asking for `wav_24000` keeps that content type honest and means the
 * duration comes from the alignment rather than from parsing frame headers.
 * 24kHz is deliberate: the 44.1kHz WAV and PCM formats need a Pro plan, and
 * voice-over for a phone-screen drama does not need them.
 */

const API_BASE = 'https://api.elevenlabs.io';

/**
 * Cents per 1,000 characters. ElevenLabs bills credits, and the value of a
 * credit depends on the plan — roughly 2.2¢/1k characters on Creator, a little
 * less on Pro — so the real number is the operator's to set. The default is the
 * Creator rate rounded up.
 */
const DEFAULT_CENTS_PER_1K_CHARS = 3;

const DEFAULT_OUTPUT_FORMAT = 'wav_24000';

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw configurationError(
      'ELEVENLABS_API_KEY is not set. Set it, or use TTS_PROVIDER=stub for local development.',
    );
  }
  return key;
}

/**
 * Whether to cast from voices added out of the shared library.
 *
 * Off by default. They need a paid plan to synthesise through the API, and the
 * refusal lands per line at the voice stage rather than at casting, so getting
 * this wrong costs a character's whole part rather than one request.
 */
function allowLibraryVoices(): boolean {
  const raw = process.env.ELEVENLABS_ALLOW_LIBRARY_VOICES?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

function centsPer1kChars(): number {
  const raw = process.env.ELEVENLABS_CENTS_PER_1K_CHARS?.trim();
  if (!raw) return DEFAULT_CENTS_PER_1K_CHARS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configurationError(`ELEVENLABS_CENTS_PER_1K_CHARS="${raw}" is not a non-negative number.`);
  }
  return parsed;
}

interface Alignment {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

/**
 * Character alignment → word timings.
 *
 * ElevenLabs reports one entry per character of the *spoken* text, whitespace
 * included. Words are the runs between whitespace; a word starts when its first
 * character does and ends when its last one does. Trailing punctuation stays
 * attached to the word so the caption reads as written.
 */
export function wordsFromAlignment(alignment: Alignment | undefined): TtsWordTiming[] {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;

  if (!chars?.length || !starts?.length || !ends?.length) return [];

  const words: TtsWordTiming[] = [];
  let current = '';
  let start = 0;
  let end = 0;

  const flush = () => {
    if (current.trim().length > 0) {
      words.push({ word: current, startSeconds: start, endSeconds: end });
    }
    current = '';
  };

  for (const [i, char] of chars.entries()) {
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (current === '') start = starts[i] ?? end;
    current += char;
    end = ends[i] ?? end;
  }
  flush();

  return words;
}

/** The last character's end time — the real length of the audio. */
function durationFromAlignment(alignment: Alignment | undefined): number {
  const ends = alignment?.character_end_times_seconds;
  if (!ends?.length) return 0;
  return Math.max(...ends);
}

/**
 * Label values make better voice tags than the label keys do: `assignDefaultVoices`
 * matches on words like "warm", "young" and "narration", which is what
 * ElevenLabs puts in the values of `age`, `description` and `use_case`.
 */
function tagsFor(voice: { labels?: Record<string, unknown>; category?: string }): string[] {
  const fromLabels = Object.values(voice.labels ?? {})
    .filter((value): value is string => typeof value === 'string')
    // "middle_aged" should match a search for "mature"-ish words on either side
    // of the underscore.
    .flatMap((value) => value.split(/[_\s]+/))
    .filter(Boolean);

  return [...new Set([...fromLabels, ...(voice.category ? [voice.category] : [])])];
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = 'elevenlabs';

  estimateCostCents(text: string): number {
    return Math.ceil((text.length / 1000) * centsPer1kChars());
  }

  async synthesize(input: { text: string; voiceId: string }): Promise<TtsResult> {
    const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT?.trim() || DEFAULT_OUTPUT_FORMAT;

    const response = await fetch(
      `${API_BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2',
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      /**
       * The one refusal worth translating.
       *
       * A 402 here means the voice this character was cast with came from the
       * shared library and the plan cannot use it through the API. Raw, it
       * arrives as a wall of JSON attached to one shot, which reads like a
       * failed line rather than a casting problem affecting every line that
       * character speaks. Said plainly, with the setting that prevents it.
       */
      const libraryVoice =
        response.status === 402 && /library voices|paid_plan_required/i.test(detail);

      throw new ProviderRequestError(
        libraryVoice
          ? `ElevenLabs refused this voice: it came from the shared voice library, which needs a ` +
            `paid plan to use through the API. Recast this character onto a built-in voice, or ` +
            `set ELEVENLABS_ALLOW_LIBRARY_VOICES=1 once the plan allows it.`
          : `ElevenLabs refused the synthesis (${response.status})${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
        // A missing voice or an exhausted quota will refuse again identically.
        { retryable: isRetryableStatus(response.status), status: response.status },
      );
    }

    const payload = (await response.json()) as {
      audio_base64?: string;
      alignment?: Alignment;
      normalized_alignment?: Alignment;
    };

    if (!payload.audio_base64) {
      throw new Error('ElevenLabs returned no audio.');
    }

    const audio = Buffer.from(payload.audio_base64, 'base64');

    /**
     * `alignment` indexes the text as submitted; `normalized_alignment` indexes
     * it after ElevenLabs expands things like "1995" into what it actually says.
     * Captions have to show the written line, not the spoken expansion, so the
     * un-normalised one is the right one to build words from — but either will
     * do for the total duration.
     */
    const alignment = payload.alignment ?? payload.normalized_alignment;
    const words = wordsFromAlignment(alignment);

    const durationSeconds = durationFromAlignment(alignment);
    if (durationSeconds <= 0) {
      throw new Error(
        'ElevenLabs returned audio with no alignment, so its duration cannot be measured.',
      );
    }

    return { audio, durationSeconds, ...(words.length > 0 ? { words } : {}) };
  }

  async listVoices(): Promise<Array<{ id: string; name: string; tags: string[] }>> {
    // 100 is the per-page maximum. A single page is plenty for casting a short
    // drama, and paginating the whole library would make the series page wait on
    // requests nobody reads.
    const response = await fetch(`${API_BASE}/v2/voices?page_size=100`, {
      headers: { 'xi-api-key': apiKey() },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderRequestError(
        `ElevenLabs voice list failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
        { retryable: isRetryableStatus(response.status), status: response.status },
      );
    }

    const payload = (await response.json()) as {
      voices?: Array<{
        voice_id?: string;
        name?: string;
        category?: string;
        /** Non-null for a voice added from the shared library. */
        sharing?: unknown;
        labels?: Record<string, unknown>;
      }>;
    };

    const all = (payload.voices ?? [])
      .filter((voice) => typeof voice.voice_id === 'string')
      .map((voice) => ({
        id: voice.voice_id!,
        name: voice.name ?? voice.voice_id!,
        tags: tagsFor(voice),
        fromLibrary: voice.sharing !== null && voice.sharing !== undefined,
      }));

    /**
     * Library voices are hidden unless the account is known to be able to use
     * them.
     *
     * A voice added from the shared library needs a paid plan to synthesise
     * through the API, and the refusal comes *at synthesis*, per line, long
     * after casting: the character is assigned a voice, the run gets to the
     * voice stage, and every line that character speaks 402s. Three characters
     * in a real run came out mute that way while the rest of the film was
     * fine.
     *
     * The plan cannot be read — that needs a `user_read` scope this key may not
     * have — so the safe default is to cast only from voices that work on any
     * plan, and let an operator who knows better opt back in.
     */
    const usable = allowLibraryVoices() ? all : all.filter((voice) => !voice.fromLibrary);

    /**
     * Falling back rather than returning nothing: an account whose voices are
     * *all* from the library would otherwise cast nobody and produce a silent
     * film, which is worse than trying and getting a clear refusal.
     */
    const chosen = usable.length > 0 ? usable : all;

    return chosen.map(({ id, name, tags }) => ({ id, name, tags }));
  }
}
