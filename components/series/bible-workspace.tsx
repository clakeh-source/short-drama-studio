'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Loader2,
  PenLine,
  RefreshCw,
  Save,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useGeneration } from '@/components/generation/use-generation';
import { APPEARANCE_PROMPT_MAX, type Bible } from '@/lib/ai/schemas';
import { VoicePicker } from '@/components/series/voice-picker';
import { ReferenceImages, type ReferenceImage } from '@/components/series/reference-images';
import { cn } from '@/lib/utils';

export interface WorkspaceCharacter {
  id: string;
  name: string;
  role: string;
  description: string;
  appearancePrompt: string;
  /** Null until a voice is chosen; assigned a sensible default at bible time. */
  voiceId: string | null;
  /** Reference stills, in canonical order. Empty until the user uploads some. */
  referenceImages: ReferenceImage[];
}

export interface WorkspaceEpisode {
  id: string;
  number: number;
  title: string;
  synopsis: string;
  status: string;
}

export interface BibleWorkspaceProps {
  seriesId: string;
  seriesTitle: string;
  premise: string;
  episodeTargetSeconds: number;
  bible: Bible | null;
  characters: WorkspaceCharacter[];
  episodes: WorkspaceEpisode[];
  /** Set when the wizard hands off — kicks generation automatically. */
  autoGenerate: boolean;
}

type DoneEvent = { bible: Bible; attempts: number; costCents: number };

export function BibleWorkspace(props: BibleWorkspaceProps) {
  const router = useRouter();
  const generation = useGeneration<DoneEvent>();

  const [bible, setBible] = useState<Bible | null>(props.bible);
  const [cast, setCast] = useState(props.characters);

  /*
   * Re-sync the cast when the server sends a different set of characters.
   *
   * Generating a bible inserts the cast server-side and then calls
   * `router.refresh()`. Without this the client keeps whatever it was
   * constructed with — which, on the wizard hand-off, is an empty array, so the
   * Cast section rendered its heading and nothing else even though four
   * characters were sitting in the database.
   *
   * Keyed on the id set rather than the array identity: every refresh produces a
   * new array, and re-syncing on that would discard a half-typed appearance
   * prompt the moment anything else on the page refreshed.
   */
  const castIds = props.characters.map((c) => c.id).join(',');
  useEffect(() => {
    setCast(props.characters);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id set
  }, [castIds]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const streamRef = useRef<HTMLPreElement>(null);
  const kicked = useRef(false);

  const generate = useCallback(async () => {
    const result = await generation.run(`/api/series/${props.seriesId}/bible`);
    if (result) {
      setBible(result.bible);
      setDirty(false);
      toast.success(
        result.attempts > 1
          ? `Bible ready (took ${result.attempts} attempts to validate).`
          : 'Bible ready.',
      );
      router.refresh();
    }
  }, [generation, props.seriesId, router]);

  // Hand-off from the creation wizard: generate once, automatically.
  useEffect(() => {
    if (props.autoGenerate && !props.bible && !kicked.current) {
      kicked.current = true;
      void generate();
    }
  }, [props.autoGenerate, props.bible, generate]);

  // Keep the raw stream pinned to the newest token.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [generation.text]);

  function patchBible(patch: Partial<Bible>) {
    setBible((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  async function saveBible() {
    if (!bible) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/series/${props.seriesId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bible }),
      });
      if (!response.ok) throw new Error('Save failed');
      setDirty(false);
      toast.success('Bible saved.');
      router.refresh();
    } catch {
      toast.error('Could not save the bible.');
    } finally {
      setSaving(false);
    }
  }

  async function saveCharacter(character: WorkspaceCharacter) {
    const response = await fetch(`/api/characters/${character.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: character.name,
        role: character.role,
        description: character.description,
        appearancePrompt: character.appearancePrompt,
        voiceId: character.voiceId,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      throw new Error(payload?.error?.message ?? 'Save failed');
    }
    router.refresh();
  }

  const streaming = generation.state === 'streaming';

  /* ---------------------------------------------------------------------- */

  const castCard =
    cast.length > 0 ? (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            Cast
          </CardTitle>
          <CardDescription>
            The appearance prompt is copied verbatim into every shot this character appears in.
            It is the only thing keeping them looking like the same person across shots.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cast.map((character) => (
            <CharacterEditor
              key={character.id}
              character={character}
              onChange={(next) => setCast((prev) => prev.map((c) => (c.id === next.id ? next : c)))}
              onSave={saveCharacter}
            />
          ))}
        </CardContent>
      </Card>
    ) : null;

  if (!bible) {
    // A series can have a cast and no bible — an imported script produces
    // exactly that, and so does the seed. Showing the empty state on its own
    // would leave those characters, and their reference stills, unreachable.
    return (
      <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
          {streaming ? (
            <>
              <Loader2 className="size-8 animate-spin text-primary" />
              <div>
                <h2 className="font-medium">{generation.status || 'Developing the bible…'}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {generation.firstTokenMs !== null
                    ? `First token in ${generation.firstTokenMs}ms`
                    : 'Waiting for the first token…'}
                </p>
              </div>
              <StreamView ref={streamRef} text={generation.text} thinking={generation.thinking} />
            </>
          ) : (
            <>
              <Sparkles className="size-8 text-muted-foreground" />
              <div>
                <h2 className="font-medium">No bible yet</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  {props.premise}
                </p>
              </div>
              {generation.error ? (
                <p className="max-w-md text-sm text-destructive">{generation.error}</p>
              ) : null}
              <Button onClick={generate}>
                <Sparkles />
                Generate series bible
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      {castCard}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {streaming ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>{generation.status || 'Regenerating…'}</span>
              {generation.firstTokenMs !== null ? (
                <Badge variant="outline">first token {generation.firstTokenMs}ms</Badge>
              ) : null}
            </div>
            <StreamView ref={streamRef} text={generation.text} thinking={generation.thinking} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Series bible</CardTitle>
            <CardDescription>
              Edit anything. This document steers every script and every shot prompt.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty ? <Badge variant="warning">unsaved</Badge> : null}
            <Button variant="outline" size="sm" onClick={generate} disabled={streaming}>
              <RefreshCw className={cn(streaming && 'animate-spin')} />
              Regenerate
            </Button>
            <Button size="sm" onClick={saveBible} disabled={!dirty || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bible-title">Title</Label>
            <Input
              id="bible-title"
              value={bible.title}
              onChange={(e) => patchBible({ title: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bible-logline">Logline</Label>
            <Textarea
              id="bible-logline"
              rows={2}
              value={bible.logline}
              onChange={(e) => patchBible({ logline: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bible-world">World</Label>
            <Textarea
              id="bible-world"
              rows={4}
              value={bible.world}
              onChange={(e) => patchBible({ world: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bible-tone">Tone rules — one per line</Label>
            <Textarea
              id="bible-tone"
              rows={4}
              value={bible.tone_rules.join('\n')}
              onChange={(e) =>
                patchBible({
                  tone_rules: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean),
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bible-arc">Season arc</Label>
            <Textarea
              id="bible-arc"
              rows={3}
              value={bible.season_arc}
              onChange={(e) => patchBible({ season_arc: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {castCard}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Episodes</CardTitle>
          <CardDescription>
            {props.episodes.length} × {props.episodeTargetSeconds}s. Open one to write its script.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {props.episodes.map((episode) => (
            <Link
              key={episode.id}
              href={`/series/${props.seriesId}/episodes/${episode.number}`}
              className="flex items-start gap-4 py-3 transition-colors hover:bg-accent/40"
            >
              <span className="mt-0.5 w-8 shrink-0 font-mono text-sm text-muted-foreground">
                {String(episode.number).padStart(2, '0')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{episode.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {episode.synopsis}
                </span>
              </span>
              <Badge variant={episode.status === 'draft' ? 'outline' : 'success'}>
                {episode.status}
              </Badge>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CharacterEditor({
  character,
  onChange,
  onSave,
}: {
  character: WorkspaceCharacter;
  onChange: (next: WorkspaceCharacter) => void;
  onSave: (character: WorkspaceCharacter) => Promise<void>;
}) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function update(patch: Partial<WorkspaceCharacter>) {
    onChange({ ...character, ...patch });
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(character);
      setDirty(false);
      setSaved(true);
      toast.success(`${character.name} saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1 space-y-1.5">
          <Label htmlFor={`name-${character.id}`}>Name</Label>
          <Input
            id={`name-${character.id}`}
            value={character.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>
        <div className="min-w-32 flex-1 space-y-1.5">
          <Label htmlFor={`role-${character.id}`}>Role</Label>
          <Input
            id={`role-${character.id}`}
            value={character.role}
            onChange={(e) => update({ role: e.target.value })}
          />
        </div>
        <Button size="sm" variant={dirty ? 'default' : 'ghost'} onClick={save} disabled={!dirty || saving}>
          {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : <PenLine />}
          {saving ? 'Saving' : saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      <div className="mt-3 space-y-1.5">
        <Label htmlFor={`desc-${character.id}`}>Description</Label>
        <Textarea
          id={`desc-${character.id}`}
          rows={2}
          value={character.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </div>

      <div className="mt-3 space-y-1.5">
        <Label htmlFor={`appearance-${character.id}`}>
          Appearance prompt
          <span className="ml-2 font-normal text-muted-foreground">
            physical only — no names, no story, no camera
          </span>
        </Label>
        <Textarea
          id={`appearance-${character.id}`}
          rows={3}
          className="font-mono text-xs"
          value={character.appearancePrompt}
          onChange={(e) => update({ appearancePrompt: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {character.appearancePrompt.length}/{APPEARANCE_PROMPT_MAX} characters
        </p>
      </div>

      <div className="mt-3">
        <VoicePicker
          voiceId={character.voiceId}
          characterName={character.id}
          onChange={(voiceId) => update({ voiceId })}
          disabled={saving}
        />
      </div>

      <ReferenceImages
        characterId={character.id}
        characterName={character.name}
        initial={character.referenceImages}
      />
    </div>
  );
}

function StreamView({
  ref,
  text,
  thinking,
}: {
  ref: React.Ref<HTMLPreElement>;
  text: string;
  thinking: string;
}) {
  // Reasoning arrives first and is the only thing on screen while the model
  // works; the answer replaces it the moment the first character lands.
  const showing = text || thinking;
  return (
    <div className="w-full space-y-1">
      <p className="text-left text-xs text-muted-foreground">
        {text ? 'Writing' : thinking ? 'Thinking' : 'Connecting'}
      </p>
      <pre
        ref={ref}
        aria-live="polite"
        className={cn(
          'max-h-48 w-full overflow-y-auto rounded-md bg-muted/40 p-3 text-left font-mono text-xs leading-relaxed',
          text ? 'text-muted-foreground' : 'italic text-muted-foreground/70',
        )}
      >
        {showing || 'Waiting for the model…'}
      </pre>
    </div>
  );
}
