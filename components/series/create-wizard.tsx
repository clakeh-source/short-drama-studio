'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const GENRES = [
  'Revenge',
  'Secret identity',
  'Billionaire romance',
  'Family betrayal',
  'Workplace thriller',
  'Supernatural',
  'Crime',
  'Medical',
] as const;

const TONES = ['Cold and controlled', 'Melodramatic', 'Darkly funny', 'Tense', 'Tender'] as const;

const AUDIENCES = ['Adults 18-34', 'Adults 25-44', 'Adults 35+', 'General adult'] as const;

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
] as const;

const EXAMPLES = [
  'A hotel night manager recognises a guest she buried three months ago.',
  'A cleaner at a law firm finds her own name in a sealed settlement.',
  'The family driver has been quietly paying off the heir’s debts for a decade.',
];

export function CreateSeriesWizard() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [premise, setPremise] = useState('');
  const [genre, setGenre] = useState<string>(GENRES[0]);
  const [tone, setTone] = useState<string>(TONES[0]);
  const [audience, setAudience] = useState<string>(AUDIENCES[0]);
  const [language, setLanguage] = useState('en');
  const [episodeCount, setEpisodeCount] = useState(6);
  const [episodeSeconds, setEpisodeSeconds] = useState(60);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    try {
      const response = await fetch('/api/series', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          premise,
          genre,
          tone,
          audience,
          language,
          episodeCount,
          episodeSeconds,
        }),
      });

      const payload = (await response.json()) as
        | { id: string }
        | { error: { message: string; details?: { reasons?: string[] } } };

      if (!response.ok) {
        const message = 'error' in payload ? payload.error.message : 'Could not create the series.';
        toast.error(message, { duration: 8000 });
        return;
      }

      // The bible is generated on the next screen, where the user can watch it
      // and edit it before anything downstream spends money.
      router.push(`/series/${(payload as { id: string }).id}?generate=bible`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the series.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>The premise</CardTitle>
          <CardDescription>
            One line. Who wants what, and what is in the way. Everything else is derived from this.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            id="premise"
            required
            minLength={10}
            maxLength={500}
            rows={3}
            placeholder="A hotel night manager recognises a guest she buried three months ago."
            value={premise}
            onChange={(e) => setPremise(e.target.value)}
            disabled={pending}
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPremise(example)}
                disabled={pending}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                {example.slice(0, 44)}…
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shape of the show</CardTitle>
          <CardDescription>
            These steer the bible. You can edit everything it produces afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="genre">Genre</Label>
            <Select
              id="genre"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              disabled={pending}
            >
              {GENRES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tone">Tone</Label>
            <Select
              id="tone"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              disabled={pending}
            >
              {TONES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="audience">Audience</Label>
            <Select
              id="audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              disabled={pending}
            >
              {AUDIENCES.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="language">Language</Label>
            <Select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={pending}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="episodeCount">Episodes</Label>
            <Input
              id="episodeCount"
              type="number"
              min={1}
              max={50}
              value={episodeCount}
              onChange={(e) => setEpisodeCount(Number(e.target.value))}
              disabled={pending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="episodeSeconds">Seconds per episode</Label>
            <Input
              id="episodeSeconds"
              type="number"
              min={15}
              max={300}
              step={5}
              value={episodeSeconds}
              onChange={(e) => setEpisodeSeconds(Number(e.target.value))}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Scripts are written to hit this within 15%.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Creating the series runs a content check. Nothing is generated until you ask for it.
        </p>
        <Button type="submit" disabled={pending || premise.trim().length < 10}>
          {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {pending ? 'Checking…' : 'Create series'}
          {!pending && <ArrowRight />}
        </Button>
      </div>
    </form>
  );
}
