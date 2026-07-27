'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export interface VoiceOption {
  id: string;
  name: string;
  tags: string[];
}

/**
 * Voice selection with an in-browser audition.
 *
 * The catalogue and the sample audio both come from server routes: a TTS key is a
 * provider secret and must never reach a client component, so the browser only
 * ever sees a list of ids and a blob of WAV.
 *
 * The audition is a paid provider call, so it happens only on an explicit click —
 * never on selection change, which would bill the user for scrolling a dropdown.
 */
export function VoicePicker(props: {
  voiceId: string | null;
  onChange: (voiceId: string) => void;
  /** Shown in the audition line so the sample sounds like the character. */
  characterName: string;
  disabled?: boolean;
}) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Revoked on cleanup; a blob URL leaks the whole clip until it is. */
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/voices', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load voices');
        const payload = (await response.json()) as { voices: VoiceOption[] };
        if (!cancelled) setVoices(payload.voices);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Stop and release the clip if the card unmounts mid-playback.
  useEffect(
    () => () => {
      audio.current?.pause();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  function stop() {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  }

  async function audition() {
    if (playing) {
      stop();
      return;
    }
    if (!props.voiceId) {
      toast.info('Pick a voice first.');
      return;
    }

    setPlaying(true);
    try {
      const response = await fetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voiceId: props.voiceId }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? 'Could not synthesise a sample.');
      }

      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(await response.blob());

      const element = new Audio(objectUrl.current);
      audio.current = element;
      element.onended = () => setPlaying(false);
      element.onerror = () => {
        setPlaying(false);
        toast.error('The sample could not be played.');
      };
      await element.play();
    } catch (error) {
      setPlaying(false);
      toast.error(error instanceof Error ? error.message : 'Could not synthesise a sample.');
    }
  }

  const selected = voices?.find((v) => v.id === props.voiceId);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`voice-${props.characterName}`}>Voice</Label>
      <div className="flex gap-2">
        <Select
          id={`voice-${props.characterName}`}
          value={props.voiceId ?? ''}
          onChange={(e) => props.onChange(e.target.value)}
          disabled={props.disabled || voices === null || loadFailed}
          className="flex-1"
        >
          <option value="">
            {loadFailed
              ? 'Voice list unavailable'
              : voices === null
                ? 'Loading voices…'
                : 'No voice assigned'}
          </option>
          {voices?.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </Select>

        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void audition()}
          disabled={props.disabled || !props.voiceId}
          aria-label={playing ? 'Stop the sample' : 'Play a sample'}
          title={playing ? 'Stop' : 'Audition this voice (a small provider charge)'}
        >
          {playing ? (
            audio.current ? (
              <Square className="size-4" />
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )
          ) : (
            <Play className="size-4" />
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {selected
          ? selected.tags.join(' · ')
          : 'Every line this character speaks is synthesised with this voice.'}
      </p>
    </div>
  );
}
