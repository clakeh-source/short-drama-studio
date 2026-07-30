import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { dynamicRoute, notFound } from '@/lib/api/handler';
import { APPEARANCE_PROMPT_MAX } from '@/lib/ai/schemas';
import { withUserDb } from '@/lib/db';
import { characters, series } from '@/lib/db/schema';
import {
  confirmReferenceImages,
  deleteCharacter,
  loadCharacter,
  removeReferenceImages,
  type ConfirmResult,
} from '@/lib/data/characters';
import { MAX_REFERENCE_IMAGES } from '@/lib/characters/references';

/** The character, its reference stills, and a signed URL for each. */
export const GET = dynamicRoute<{ id: string }>(
  { operation: 'character.get' },
  async ({ params, user }) => loadCharacter(user.id, params.id),
);

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

  /**
   * `bucket/path` keys the client has finished uploading to. Confirming is a
   * separate step from getting the URL because the bytes go straight to
   * storage — this is the server's first and only chance to see what actually
   * arrived.
   */
  addReferenceImages: z
    .array(z.string().min(1).max(400))
    .min(1)
    .max(MAX_REFERENCE_IMAGES)
    .optional(),
  /** Reference image row ids to detach. Their stored objects are deleted too. */
  removeReferenceImageIds: z.array(z.uuid()).min(1).max(MAX_REFERENCE_IMAGES).optional(),
});

export const PATCH = dynamicRoute<{ id: string }, z.infer<typeof patchSchema>>(
  { operation: 'character.update', body: patchSchema },
  async ({ body, params, user }) => {
    // Removals run before additions, so "swap this still for that one" fits in
    // a single request without transiently breaching the five-image ceiling.
    const removed = body.removeReferenceImageIds
      ? await removeReferenceImages(user.id, params.id, body.removeReferenceImageIds)
      : null;

    const added: ConfirmResult | null = body.addReferenceImages
      ? await confirmReferenceImages(user.id, params.id, body.addReferenceImages)
      : null;

    const fields = await updateFields(user.id, params.id, body);

    return {
      ...fields,
      ...(removed ? { removedReferenceImages: removed.removed } : {}),
      ...(added ? { addedReferenceImages: added.added, rejectedUploads: added.rejected } : {}),
    };
  },
);

async function updateFields(
  userId: string,
  characterId: string,
  body: z.infer<typeof patchSchema>,
) {
  return withUserDb(userId, async (tx) => {
    const [existing] = await tx.select().from(characters).where(eq(characters.id, characterId));
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
      .where(eq(characters.id, characterId))
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
}

/**
 * Removes the character and every still it owns — rows and stored objects both.
 * The bible document keeps its copy of the cast; it is a generated artefact and
 * is rewritten wholesale on the next regeneration.
 */
export const DELETE = dynamicRoute<{ id: string }>(
  { operation: 'character.delete' },
  async ({ params, user }) => {
    await deleteCharacter(user.id, params.id);
    return { deleted: true };
  },
);
