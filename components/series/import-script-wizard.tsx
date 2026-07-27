'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useGeneration } from '@/components/generation/use-generation';
import type { ParseWarning, Scene, Script } from '@/lib/ai/schemas';
import { MAX_SCENES_PER_EPISODE } from '@/lib/script-import/parse';
import { AUDIENCES, GENRES, LANGUAGES, TONES } from './show-options';

/**
 * Bringing your own script: paste or upload, check what was understood, commit.
 *
 * The middle step is the point of the whole flow. Parsing somebody's script is
 * guesswork at the edges, so nothing reaches the pipeline until they have seen
 * the structure it will be shot as and had the chance to fix it. Every warning
 * the parser raised is shown against the scene it came from, not pooled at the
 * top where it would be ignored.
 */

interface ParsedEpisodeDto {
  number: number;
  title: string;
  script: Script;
  warnings: ParseWarning[];
}

interface ParseResponse {
  episodes: ParsedEpisodeDto[];
  warnings: ParseWarning[];
  speakers: string[];
  filename: string | null;
}

type Step = 'input' | 'review';

export function ImportScriptWizard() {
  const router = useRouter();
  const commit = useGeneration<{ id: string; episodeCount: number; placeholders: string[] }>();

  const [step, setStep] = useState<Step>('input');
  const [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [episodes, setEpisodes] = useState<ParsedEpisodeDto[]>([]);
  const [documentWarnings, setDocumentWarnings] = useState<ParseWarning[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);

  const [genre, setGenre] = useState<string>(GENRES[0]);
  const [tone, setTone] = useState<string>(TONES[0]);
  const [audience, setAudience] = useState<string>(AUDIENCES[0]);
  const [language, setLanguage] = useState('en');
  const [episodeSeconds, setEpisodeSeconds] = useState(60);

  const fileRef = useRef<HTMLInputElement>(null);

  const receive = useCallback((payload: ParseResponse) => {
    setEpisodes(payload.episodes);
    setDocumentWarnings(payload.warnings);
    setSpeakers(payload.speakers);
    setStep('review');
  }, []);

  async function parse(body: BodyInit, headers?: HeadersInit) {
    setPending(true);
    try {
      const response = await fetch('/api/script-import/parse', { method: 'POST', body, headers });
      const payload = (await response.json()) as ParseResponse | { error: { message: string } };
      if (!response.ok) {
        toast.error('error' in payload ? payload.error.message : 'Could not read that script.', {
          duration: 8000,
        });
        return;
      }
      receive(payload as ParseResponse);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not read that script.');
    } finally {
      setPending(false);
    }
  }

  async function onUpload(file: File) {
    const form = new FormData();
    form.append('file', file);
    await parse(form);
  }

  /**
   * Recomputed from what is on screen rather than trusting the parser's original
   * warning: the user may have just deleted the scenes that caused it.
   */
  const overLimit = episodes.filter((e) => e.script.scenes.length > MAX_SCENES_PER_EPISODE);

  async function onCommit() {
    if (overLimit.length > 0) return;

    const result = await commit.run('/api/series/import', {
      genre,
      tone,
      audience,
      language,
      episodeSeconds,
      episodes: episodes.map((e) => ({ number: e.number, title: e.title, script: e.script })),
    });

    if (!result) return;

    if (result.placeholders.length > 0) {
      toast.warning(
        `Imported. ${result.placeholders.join(', ')} had no description derived — edit their ` +
          `appearance before generating video.`,
        { duration: 10000 },
      );
    } else {
      toast.success(`Imported ${result.episodeCount} episode(s).`);
    }
    router.push(`/series/${result.id}`);
  }

  function updateEpisode(index: number, patch: Partial<ParsedEpisodeDto>) {
    setEpisodes((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }

  function updateScript(index: number, patch: Partial<Script>) {
    setEpisodes((prev) =>
      prev.map((e, i) => (i === index ? { ...e, script: { ...e.script, ...patch } } : e)),
    );
  }

  if (step === 'input') {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Your script</CardTitle>
            <CardDescription>
              Paste it, or upload a .txt, .md, .fountain or .docx. Screenplay format is understood;
              so is plain prose with “Name: line” dialogue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              id="script"
              rows={14}
              placeholder={'INT. KITCHEN - NIGHT\n\nShe reads the letter twice.\n\nNADIA\nThis is my name.'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={pending}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={pending || text.trim().length < 20}
                onClick={() =>
                  parse(JSON.stringify({ text }), { 'content-type': 'application/json' })
                }
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Read this script
              </Button>

              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.fountain,.docx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onUpload(file);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-4" />
                Upload a file
              </Button>
              <span className="text-xs text-muted-foreground">Nothing is saved until you confirm.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const busy = commit.state === 'streaming';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>What we read</CardTitle>
          <CardDescription>
            {episodes.length} episode{episodes.length === 1 ? '' : 's'} ·{' '}
            {episodes.reduce((n, e) => n + e.script.scenes.length, 0)} scenes ·{' '}
            {speakers.length} speaker{speakers.length === 1 ? '' : 's'}
            {speakers.length ? `: ${speakers.join(', ')}` : ''}. Fix anything wrong before
            confirming — this becomes the script the storyboard is built from.
          </CardDescription>
        </CardHeader>
        {documentWarnings.length > 0 ? (
          <CardContent>
            <WarningList warnings={documentWarnings} />
          </CardContent>
        ) : null}
      </Card>

      {overLimit.length > 0 ? (
        <Card className="border-destructive/50">
          <CardContent className="flex gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p>
              {overLimit.map((e) => `Episode ${e.number}`).join(', ')}{' '}
              {overLimit.length === 1 ? 'has' : 'have'} more than {MAX_SCENES_PER_EPISODE} scenes.
              Remove or merge scenes to continue — an episode of this length cannot be storyboarded.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {episodes.map((episode, episodeIndex) => (
        <Card key={episode.number}>
          <CardHeader className="space-y-3">
            <div className="flex items-center gap-3">
              <Badge variant="outline">Episode {episode.number}</Badge>
              <Input
                aria-label={`Episode ${episode.number} title`}
                value={episode.title}
                maxLength={120}
                placeholder="Episode title"
                disabled={busy}
                onChange={(e) => updateEpisode(episodeIndex, { title: e.target.value })}
              />
            </div>
            {episode.warnings.length > 0 ? <WarningList warnings={episode.warnings} /> : null}
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`hook-${episode.number}`}>Opening</Label>
                <Input
                  id={`hook-${episode.number}`}
                  value={episode.script.hook}
                  maxLength={500}
                  disabled={busy}
                  onChange={(e) => updateScript(episodeIndex, { hook: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`cliff-${episode.number}`}>Closing line</Label>
                <Input
                  id={`cliff-${episode.number}`}
                  value={episode.script.cliffhanger}
                  maxLength={500}
                  disabled={busy}
                  onChange={(e) => updateScript(episodeIndex, { cliffhanger: e.target.value })}
                />
              </div>
            </div>

            {episode.script.scenes.map((scene, sceneIndex) => (
              <SceneEditor
                key={sceneIndex}
                scene={scene}
                index={sceneIndex}
                disabled={busy}
                onChange={(patch) =>
                  updateScript(episodeIndex, {
                    scenes: episode.script.scenes.map((s, i) =>
                      i === sceneIndex ? { ...s, ...patch } : s,
                    ),
                  })
                }
                onRemove={
                  episode.script.scenes.length > 1
                    ? () =>
                        updateScript(episodeIndex, {
                          scenes: episode.script.scenes.filter((_, i) => i !== sceneIndex),
                        })
                    : undefined
                }
              />
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Shape of the show</CardTitle>
          <CardDescription>
            These steer how the cast is described and how long each episode runs. The script itself
            is yours — none of this rewrites it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Genre" id="genre">
            <Select id="genre" value={genre} disabled={busy} onChange={(e) => setGenre(e.target.value)}>
              {GENRES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tone" id="tone">
            <Select id="tone" value={tone} disabled={busy} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Audience" id="audience">
            <Select
              id="audience"
              value={audience}
              disabled={busy}
              onChange={(e) => setAudience(e.target.value)}
            >
              {AUDIENCES.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
          <Field label="Language" id="language">
            <Select
              id="language"
              value={language}
              disabled={busy}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Seconds per episode" id="episodeSeconds">
            <Input
              id="episodeSeconds"
              type="number"
              min={15}
              max={300}
              value={episodeSeconds}
              disabled={busy}
              onChange={(e) => setEpisodeSeconds(Number(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {busy || commit.error ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-sm text-muted-foreground">{commit.status || 'Working…'}</p>
            {commit.error ? <p className="text-sm text-destructive">{commit.error}</p> : null}
            {commit.thinking ? (
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {commit.thinking}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={onCommit} disabled={busy || overLimit.length > 0}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Confirm and create the series
          <ArrowRight className="size-4" />
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setStep('input')}>
          Back to the script
        </Button>
      </div>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function WarningList({ warnings }: { warnings: ParseWarning[] }) {
  return (
    <ul className="space-y-1">
      {warnings.map((warning, i) => (
        <li key={i} className="flex gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}

function SceneEditor(props: {
  scene: Scene;
  index: number;
  disabled: boolean;
  onChange: (patch: Partial<Scene>) => void;
  onRemove?: (() => void) | undefined;
}) {
  const { scene, index, disabled, onChange } = props;

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Scene {index + 1}</span>
        {scene.parse_warnings?.length ? (
          <Badge variant="outline" className="text-amber-600">
            needs a look
          </Badge>
        ) : null}
        <div className="flex-1" />
        {props.onRemove ? (
          <button
            type="button"
            aria-label={`Remove scene ${index + 1}`}
            disabled={disabled}
            onClick={props.onRemove}
            className="text-muted-foreground transition-colors hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        ) : null}
      </div>

      {scene.parse_warnings?.length ? <WarningList warnings={scene.parse_warnings} /> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label={`Scene ${index + 1} location`}
          value={scene.location}
          maxLength={160}
          disabled={disabled}
          onChange={(e) => onChange({ location: e.target.value })}
        />
        <Input
          aria-label={`Scene ${index + 1} time of day`}
          value={scene.time_of_day}
          maxLength={60}
          disabled={disabled}
          onChange={(e) => onChange({ time_of_day: e.target.value })}
        />
      </div>

      <Input
        aria-label={`Scene ${index + 1} summary`}
        value={scene.summary}
        maxLength={600}
        disabled={disabled}
        onChange={(e) => onChange({ summary: e.target.value })}
      />

      <div className="space-y-2">
        {scene.beats.map((beat, beatIndex) => (
          <div key={beatIndex} className="grid gap-2 rounded border border-border/60 p-2 sm:grid-cols-[10rem_1fr]">
            <Input
              aria-label={`Scene ${index + 1} beat ${beatIndex + 1} speaker`}
              placeholder="Speaker"
              value={beat.speaker ?? ''}
              maxLength={80}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  beats: scene.beats.map((b, i) =>
                    i === beatIndex ? { ...b, speaker: e.target.value || null } : b,
                  ),
                })
              }
            />
            <div className="space-y-2">
              <Textarea
                aria-label={`Scene ${index + 1} beat ${beatIndex + 1} action`}
                rows={2}
                value={beat.action}
                maxLength={600}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    beats: scene.beats.map((b, i) =>
                      i === beatIndex ? { ...b, action: e.target.value } : b,
                    ),
                  })
                }
              />
              <Input
                aria-label={`Scene ${index + 1} beat ${beatIndex + 1} dialogue`}
                placeholder="Dialogue (optional)"
                value={beat.dialogue ?? ''}
                maxLength={400}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    beats: scene.beats.map((b, i) =>
                      i === beatIndex ? { ...b, dialogue: e.target.value || null } : b,
                    ),
                  })
                }
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
