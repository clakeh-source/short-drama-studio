import type { TtsProvider } from '../types';
import { delay, failureFor, STUB_LATENCY_MS } from './support';

/** ElevenLabs-ish: roughly $0.0003 per character, floored at a tenth of a cent. */
const CENTS_PER_1K_CHARS = 30;

/** Used to fake a plausible clip length from the script text. */
const WORDS_PER_SECOND = 2.5;

export function estimateSpokenSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.5, Math.round((words / WORDS_PER_SECOND) * 10) / 10);
}

/**
 * An audible placeholder of the requested length.
 *
 * This used to be digital silence, which was valid, cheap and wrong: every film
 * made without a paid TTS key came out mute, and a mute film is
 * indistinguishable from a broken audio pipeline. The mix, the delays, the
 * ducking and the loudness pass all ran correctly and produced -91 dB, so there
 * was nothing to hear and nothing to debug.
 *
 * A tone fixes that. It is deliberately not speech — nobody should mistake this
 * for a voice — but it lands where the line lands, for as long as the line
 * lasts, so timing, ducking and the music bed are all audible and checkable.
 * The pitch is derived from the voice, so two characters do not sound alike.
 */
function toneWav(seconds: number, voiceId: string, sampleRate = 24_000): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = samples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  // A voice's pitch, in the range a human speaking voice occupies, so the mix
  // behaves the way it will with real speech in it.
  let hash = 0;
  for (const char of voiceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const frequency = 140 + (hash % 120);

  /**
   * Syllables, roughly.
   *
   * A continuous tone would duck the music bed for the whole line and hide any
   * bug in how the mix handles gaps. Pulsing at a speaking cadence keeps the
   * envelope closer to what real dialogue does to the mix.
   */
  const SYLLABLES_PER_SECOND = 4;
  const AMPLITUDE = 0.22 * 0x7fff;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const pulse = Math.sin(2 * Math.PI * SYLLABLES_PER_SECOND * t);
    const envelope = Math.max(0, pulse) ** 2;
    // Fade the last 30ms so consecutive lines do not click into each other.
    const tail = Math.min(1, (samples - i) / (sampleRate * 0.03));
    const value = Math.sin(2 * Math.PI * frequency * t) * envelope * tail * AMPLITUDE;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }

  return buffer;
}

export class StubTtsProvider implements TtsProvider {
  readonly id = 'stub';

  estimateCostCents(text: string): number {
    return Math.max(1, Math.ceil((text.length / 1000) * CENTS_PER_1K_CHARS));
  }

  async synthesize(input: {
    text: string;
    voiceId: string;
  }): Promise<{ audio: Buffer; durationSeconds: number }> {
    await delay(STUB_LATENCY_MS);

    const failure = failureFor(`${input.text} ${input.voiceId}`);
    if (failure) throw new Error(failure.error);

    const durationSeconds = estimateSpokenSeconds(input.text);
    return { audio: toneWav(durationSeconds, input.voiceId), durationSeconds };
  }

  async listVoices(): Promise<Array<{ id: string; name: string; tags: string[] }>> {
    await delay(STUB_LATENCY_MS);
    return [
      { id: 'stub-voice-lead-f', name: 'Mara (lead, female)', tags: ['female', 'young', 'warm'] },
      { id: 'stub-voice-lead-m', name: 'Dane (lead, male)', tags: ['male', 'young', 'gritty'] },
      { id: 'stub-voice-antag', name: 'Vex (antagonist)', tags: ['male', 'mature', 'cold'] },
      { id: 'stub-voice-narrator', name: 'Narrator', tags: ['neutral', 'narration'] },
    ];
  }
}
