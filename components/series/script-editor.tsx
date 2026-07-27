'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clapperboard,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useGeneration } from '@/components/generation/use-generation';
import type { Beat, Scene, Script } from '@/lib/ai/schemas';
import { estimateScriptSeconds, estimateSceneSeconds } from '@/lib/timing';
import { cn } from '@/lib/utils';

export interface ScriptEditorProps {
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  synopsis: string;
  targetSeconds: number;
  castNames: string[];
  script: Script | null;
}

type ScriptDone = {
  script: Script;
  attempts: number;
  costCents: number;
  estimatedSeconds: number;
  targetSeconds: number;
  drift: number;
};

type SceneDone = { script: Script; sceneIndex: number; costCents: number };

export function ScriptEditor(props: ScriptEditorProps) {
  const router = useRouter();
  const whole = useGeneration<ScriptDone>();
  const scene = useGeneration<SceneDone>();

  const [script, setScript] = useState<Script | null>(props.script);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyScene, setBusyScene] = useState<number | null>(null);
  const streamRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [whole.text, scene.text]);

  const generate = useCallback(async () => {
    const result = await whole.run(`/api/episodes/${props.episodeId}/script`);
    if (result) {
      setScript(result.script);
      setDirty(false);
      const pct = Math.round(result.drift * 100);
      toast.success(
        `Script ready — ${result.estimatedSeconds}s against a ${result.targetSeconds}s target (${pct}% off).`,
      );
      router.refresh();
    }
  }, [whole, props.episodeId, router]);

  async function regenerateScene(index: number) {
    setBusyScene(index);
    try {
      const result = await scene.run(`/api/episodes/${props.episodeId}/scenes/${index}`, {});
      if (result) {
        setScript(result.script);
        setDirty(false);
        toast.success(`Scene ${index + 1} rewritten.`);
        router.refresh();
      }
    } finally {
      setBusyScene(null);
    }
  }

  async function save() {
    if (!script) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/episodes/${props.episodeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script }),
      });
      if (!response.ok) throw new Error('Save failed');
      setDirty(false);
      toast.success('Script saved.');
      router.refresh();
    } catch {
      toast.error('Could not save the script.');
    } finally {
      setSaving(false);
    }
  }

  function updateScene(index: number, patch: Partial<Scene>) {
    setScript((prev) =>
      prev
        ? { ...prev, scenes: prev.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s)) }
        : prev,
    );
    setDirty(true);
  }

  function updateBeat(sceneIndex: number, beatIndex: number, patch: Partial<Beat>) {
    setScript((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        scenes: prev.scenes.map((s, i) =>
          i === sceneIndex
            ? { ...s, beats: s.beats.map((b, j) => (j === beatIndex ? { ...b, ...patch } : b)) }
            : s,
        ),
      };
    });
    setDirty(true);
  }

  function addBeat(sceneIndex: number) {
    updateScene(sceneIndex, {
      beats: [
        ...(script?.scenes[sceneIndex]?.beats ?? []),
        { action: 'New beat.', dialogue: null, speaker: null },
      ],
    });
  }

  function removeBeat(sceneIndex: number, beatIndex: number) {
    const beats = script?.scenes[sceneIndex]?.beats ?? [];
    if (beats.length <= 1) {
      toast.error('A scene needs at least one beat.');
      return;
    }
    updateScene(sceneIndex, { beats: beats.filter((_, j) => j !== beatIndex) });
  }

  const streaming = whole.state === 'streaming' || scene.state === 'streaming';
  const streamText = scene.state === 'streaming' ? scene.text : whole.text;
  const streamThinking = scene.state === 'streaming' ? scene.thinking : whole.thinking;
  const streamStatus = scene.state === 'streaming' ? scene.status : whole.status;
  const firstTokenMs = scene.state === 'streaming' ? scene.firstTokenMs : whole.firstTokenMs;

  const estimated = script ? Math.round(estimateScriptSeconds(script.scenes)) : 0;
  const drift = props.targetSeconds ? Math.abs(estimated - props.targetSeconds) / props.targetSeconds : 0;

  /* ---------------------------------------------------------------------- */

  if (!script) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
          {streaming ? (
            <>
              <Loader2 className="size-8 animate-spin text-primary" />
              <div>
                <h2 className="font-medium">{streamStatus || 'Writing the episode…'}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {firstTokenMs !== null
                    ? `First token in ${firstTokenMs}ms`
                    : 'Waiting for the first token…'}
                </p>
              </div>
              <StreamView ref={streamRef} text={streamText} thinking={streamThinking} />
            </>
          ) : (
            <>
              <Clapperboard className="size-8 text-muted-foreground" />
              <div>
                <h2 className="font-medium">No script yet</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  {props.synopsis}
                </p>
              </div>
              {whole.error ? (
                <p className="max-w-md text-sm text-destructive">{whole.error}</p>
              ) : null}
              <Button onClick={generate}>
                <Sparkles />
                Write episode {props.episodeNumber}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {streaming ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>{streamStatus || 'Working…'}</span>
              {firstTokenMs !== null ? (
                <Badge variant="outline">first token {firstTokenMs}ms</Badge>
              ) : null}
            </div>
            <StreamView ref={streamRef} text={streamText} thinking={streamThinking} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Timing</CardTitle>
            <CardDescription>
              Dialogue at 2.5 words/second plus action beats.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty ? <Badge variant="warning">unsaved</Badge> : null}
            <Badge variant={drift <= 0.15 ? 'success' : 'warning'}>
              {estimated}s / {props.targetSeconds}s
            </Badge>
            <Button variant="outline" size="sm" onClick={generate} disabled={streaming}>
              <RefreshCw className={cn(whole.state === 'streaming' && 'animate-spin')} />
              Rewrite all
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hook">Hook — first 3 seconds</Label>
              <Textarea
                id="hook"
                rows={2}
                value={script.hook}
                onChange={(e) => {
                  setScript({ ...script, hook: e.target.value });
                  setDirty(true);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cliffhanger">Cliffhanger — final line</Label>
              <Textarea
                id="cliffhanger"
                rows={2}
                value={script.cliffhanger}
                onChange={(e) => {
                  setScript({ ...script, cliffhanger: e.target.value });
                  setDirty(true);
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {script.scenes.map((sc, sceneIndex) => (
        <Card key={sceneIndex}>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">
                Scene {sceneIndex + 1}
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {Math.round(estimateSceneSeconds(sc))}s
                </span>
              </CardTitle>
              <CardDescription>{sc.summary}</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => regenerateScene(sceneIndex)}
              disabled={streaming}
            >
              {busyScene === sceneIndex ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Regenerate scene
            </Button>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`loc-${sceneIndex}`}>Location</Label>
                <Input
                  id={`loc-${sceneIndex}`}
                  value={sc.location}
                  onChange={(e) => updateScene(sceneIndex, { location: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`tod-${sceneIndex}`}>Time of day</Label>
                <Input
                  id={`tod-${sceneIndex}`}
                  value={sc.time_of_day}
                  onChange={(e) => updateScene(sceneIndex, { time_of_day: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-3">
              {sc.beats.map((beat, beatIndex) => (
                <div
                  key={beatIndex}
                  className="rounded-lg border border-border bg-background/40 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground">
                      beat {beatIndex + 1}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete beat ${beatIndex + 1}`}
                      onClick={() => removeBeat(sceneIndex, beatIndex)}
                    >
                      <Trash2 />
                    </Button>
                  </div>

                  <Textarea
                    rows={2}
                    placeholder="Action"
                    value={beat.action}
                    onChange={(e) => updateBeat(sceneIndex, beatIndex, { action: e.target.value })}
                  />

                  <div className="mt-2 flex flex-wrap gap-2">
                    <div className="min-w-40">
                      <Select
                        aria-label="Speaker"
                        value={beat.speaker ?? ''}
                        onChange={(e) =>
                          updateBeat(sceneIndex, beatIndex, {
                            speaker: e.target.value || null,
                          })
                        }
                      >
                        <option value="">— no dialogue —</option>
                        {props.castNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Input
                      className="min-w-48 flex-1"
                      placeholder="Line — under 12 words"
                      value={beat.dialogue ?? ''}
                      onChange={(e) =>
                        updateBeat(sceneIndex, beatIndex, {
                          dialogue: e.target.value || null,
                        })
                      }
                    />
                  </div>

                  {beat.dialogue && beat.dialogue.trim().split(/\s+/).length > 12 ? (
                    <p className="mt-2 text-xs text-[var(--warning)]">
                      {beat.dialogue.trim().split(/\s+/).length} words — the format wants under 12.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <Button variant="ghost" size="sm" onClick={() => addBeat(sceneIndex)}>
              <Plus />
              Add beat
            </Button>
          </CardContent>
        </Card>
      ))}
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
