import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { dynamicRoute, notFound } from '@/lib/api/handler';
import { bibleSchema } from '@/lib/ai/schemas';
import { CAPTION_PRESETS } from '@/lib/captions';
import { withUserDb } from '@/lib/db';
import { series } from '@/lib/db/schema';
import { loadSeries } from '@/lib/data/series';

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  /** Burned-in caption preset. Must name a preset that exists. */
  captionStyleId: z.enum(Object.keys(CAPTION_PRESETS) as [string, ...string[]]).optional(),
  logline: z.string().min(1).max(300).optional(),
  genre: z.string().max(60).optional(),
  tone: z.string().max(60).optional(),
  audience: z.string().max(60).optional(),
  /** Whole-bible replacement from the review screen's editors. */
  bible: bibleSchema.optional(),
});

/** Human edits to the bible. The review screen writes through this. */
export const PATCH = dynamicRoute<{ id: string }, z.infer<typeof patchSchema>>(
  { operation: 'series.update', body: patchSchema },
  async ({ body, params, user }) => {
    const { series: row, characters: cast } = await loadSeries(user.id, params.id);
    if (!row) throw notFound('Series not found');

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.logline !== undefined) updates.logline = body.logline;
    if (body.genre !== undefined) updates.genre = body.genre;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.audience !== undefined) updates.audience = body.audience;
    if (body.captionStyleId !== undefined) updates.captionStyleId = body.captionStyleId;
    if (body.bible !== undefined) {
      // The `characters` table is the source of truth for the cast — character
      // edits go through /api/characters/[id]. Re-derive the document's cast
      // from it so a concurrent bible save cannot clobber an appearance_prompt.
      updates.bible = {
        ...body.bible,
        characters: cast.map((c) => ({
          name: c.name,
          role: c.role,
          description: c.description,
          appearance_prompt: c.appearancePrompt,
        })),
      };
      // Keep the denormalised columns in step with the document.
      updates.title = body.bible.title;
      updates.logline = body.bible.logline;
    }

    if (Object.keys(updates).length === 0) return { updated: false };

    await withUserDb(user.id, (tx) =>
      tx.update(series).set(updates).where(eq(series.id, params.id)),
    );

    return { updated: true };
  },
);

export const GET = dynamicRoute<{ id: string }>(
  { operation: 'series.get' },
  async ({ params, user }) => loadSeries(user.id, params.id),
);
