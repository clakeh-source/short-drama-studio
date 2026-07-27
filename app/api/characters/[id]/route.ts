import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { dynamicRoute, notFound } from '@/lib/api/handler';
import { APPEARANCE_PROMPT_MAX } from '@/lib/ai/schemas';
import { withUserDb } from '@/lib/db';
import { characters, series } from '@/lib/db/schema';

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.string().max(60).optional(),
  description: z.string().max(600).optional(),
  /**
   * The load-bearing field: this string is concatenated verbatim into every
   * shot prompt the character appears in (Phase 2), so an edit here changes
   * how they look in every frame of every episode.
   */
  appearancePrompt: z.string().min(20).max(APPEARANCE_PROMPT_MAX).optional(),
  voiceId: z.string().max(120).nullable().optional(),
});

export const PATCH = dynamicRoute<{ id: string }, z.infer<typeof patchSchema>>(
  { operation: 'character.update', body: patchSchema },
  async ({ body, params, user }) => {
    return withUserDb(user.id, async (tx) => {
      const [existing] = await tx.select().from(characters).where(eq(characters.id, params.id));
      if (!existing) throw notFound('Character not found');

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.role !== undefined) updates.role = body.role;
      if (body.description !== undefined) updates.description = body.description;
      if (body.appearancePrompt !== undefined) updates.appearancePrompt = body.appearancePrompt;
      if (body.voiceId !== undefined) updates.voiceId = body.voiceId;

      if (Object.keys(updates).length === 0) return { updated: false };

      const [row] = await tx
        .update(characters)
        .set(updates)
        .where(eq(characters.id, params.id))
        .returning();

      // The bible document holds its own copy of the cast; keep it in step so a
      // later regeneration prompt sees the edited appearance, not the original.
      const [seriesRow] = await tx.select().from(series).where(eq(series.id, existing.seriesId));
      const bible = seriesRow?.bible as { characters?: Array<Record<string, unknown>> } | null;

      if (bible?.characters) {
        const next = bible.characters.map((c) =>
          c.name === existing.name
            ? {
                ...c,
                name: row!.name,
                role: row!.role,
                description: row!.description,
                appearance_prompt: row!.appearancePrompt,
              }
            : c,
        );
        await tx
          .update(series)
          .set({ bible: { ...bible, characters: next } })
          .where(eq(series.id, existing.seriesId));
      }

      return { updated: true, character: row };
    });
  },
);
