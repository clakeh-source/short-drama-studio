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

/** A silent WAV of the requested length — real bytes, so downstream code works. */
function silentWav(seconds: number, sampleRate = 24_000): Buffer {
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
    return { audio: silentWav(durationSeconds), durationSeconds };
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
