import { badRequest } from '@/lib/api/handler';
import { sseRoute } from '@/lib/api/sse';
import { deriveBibleFromScript } from '@/lib/ai/bible-from-script';
import { screenContent } from '@/lib/ai/safety';
import { importScriptInputSchema } from '@/lib/ai/schemas';
import { withUserDb } from '@/lib/db';
import { episodes as episodesTable, series } from '@/lib/db/schema';
import { persistBible, persistScript } from '@/lib/data/series';
import { getLlmProvider } from '@/lib/providers';
import { recordUsage } from '@/lib/usage';
import { eq } from 'drizzle-orm';

/**
 * Commits a script the user brought, and everything the pipeline needs to shoot
 * it.
 *
 * Streamed rather than a plain POST because deriving the bible is a full model
 * round trip; the generated path shows its working while it waits, and this one
 * should not feel more opaque for having skipped a step.
 *
 * Order matters. Safety screening runs before the row exists, so a refused
 * script costs the screening call and nothing else — the same guarantee
 * `POST /api/series` gives a refused premise.
 */
export const POST = sseRoute<Record<string, never>, ReturnType<typeof importScriptInputSchema.parse>>(
  { operation: 'series.import', body: importScriptInputSchema },
  async ({ body, user, send }) => {
    const provider = getLlmProvider();

    const numbers = body.episodes.map((e) => e.number);
    if (new Set(numbers).size !== numbers.length) {
      throw badRequest('Two episodes have the same number. Renumber them before importing.');
    }

    send('status', { message: 'Screening the script…' });

    /**
     * Screened on dialogue and action, not the whole document: the rules care
     * about depicted content, and a 100-page screenplay would be an expensive
     * way to ask the same question. 8k characters is several scenes.
     */
    const sample = body.episodes
      .flatMap((e) => e.script.scenes.flatMap((s) => s.beats.map((b) => b.dialogue ?? b.action)))
      .join('\n')
      .slice(0, 8_000);

    const verdict = await screenContent({ provider, text: sample });

    if (verdict.costCents !== undefined) {
      await recordUsage({
        userId: user.id,
        provider: provider.id,
        operation: 'safety.screen',
        costCents: verdict.costCents,
        tokensIn: verdict.tokensIn ?? null,
        tokensOut: verdict.tokensOut ?? null,
      });
    }

    if (!verdict.allowed) {
      throw badRequest(verdict.reasons[0] ?? 'That script cannot be generated.', {
        reasons: verdict.reasons,
      });
    }

    send('status', { message: 'Working out how everyone looks…' });

    const speakers: string[] = [];
    for (const episode of body.episodes) {
      for (const scene of episode.script.scenes) {
        for (const beat of scene.beats) {
          if (beat.speaker && !speakers.includes(beat.speaker)) speakers.push(beat.speaker);
        }
      }
    }

    const derived = await deriveBibleFromScript({
      provider,
      episodes: body.episodes.map((e) => ({
        number: e.number,
        title: e.title,
        script: e.script,
        warnings: [],
      })),
      speakers,
      language: body.language,
      episodeSeconds: body.episodeSeconds,
      onDelta: (chunk) => send('delta', chunk),
    });

    send('status', { message: 'Saving…' });

    const [row] = await withUserDb(user.id, (tx) =>
      tx
        .insert(series)
        .values({
          userId: user.id,
          title: derived.bible.title,
          logline: derived.bible.logline,
          genre: body.genre,
          tone: body.tone,
          audience: body.audience,
          language: body.language,
          episodeTargetCount: body.episodes.length,
          episodeTargetSeconds: body.episodeSeconds,
          scriptSource: 'user_provided',
          status: 'draft',
        })
        .returning({ id: series.id }),
    );

    const seriesId = row!.id;

    // Creates the cast and the episode rows from the derived bible, exactly as
    // the generated path does — which is what lets everything downstream stay
    // ignorant of where the script came from.
    await persistBible(user.id, seriesId, derived.bible);

    const created = await withUserDb(user.id, (tx) =>
      tx
        .select({ id: episodesTable.id, number: episodesTable.number })
        .from(episodesTable)
        .where(eq(episodesTable.seriesId, seriesId)),
    );
    const byNumber = new Map(created.map((e) => [e.number, e.id]));

    for (const episode of body.episodes) {
      const id = byNumber.get(episode.number);
      // persistBible created a row per bible episode, and the bible was built
      // from these same episodes — a miss would mean the two drifted.
      if (!id) continue;
      await persistScript(user.id, id, episode.script);
    }

    await recordUsage({
      userId: user.id,
      seriesId,
      provider: provider.id,
      operation: 'bible.derive',
      costCents: derived.usage.costCents,
      tokensIn: derived.usage.tokensIn,
      tokensOut: derived.usage.tokensOut,
    });

    send('done', {
      id: seriesId,
      episodeCount: body.episodes.length,
      /**
       * Speakers the model did not describe. They have working placeholder
       * appearances, so the pipeline runs — but they will all look generic
       * until someone edits them, and saying so is cheaper than the user
       * discovering it in a rendered clip.
       */
      placeholders: derived.placeholders,
      costCents: derived.usage.costCents,
    });
  },
);

/** Screening plus a full bible derivation; see docs/DEPLOY.md on function limits. */
export const maxDuration = 300;
