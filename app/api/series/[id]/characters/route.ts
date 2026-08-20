import { z } from 'zod';
import { dynamicRoute } from '@/lib/api/handler';
import { APPEARANCE_PROMPT_MAX } from '@/lib/ai/schemas';
import { createCharacter, issueReferenceUploads } from '@/lib/data/characters';
import { MAX_REFERENCE_IMAGES } from '@/lib/characters/references';

/**
 * Creates a character, and optionally hands back upload URLs for its reference
 * stills in the same response.
 *
 * The stills themselves never come through here. The client declares what it is
 * about to send, gets one signed URL per file, PUTs the bytes straight to
 * storage, and then confirms via `PATCH /api/characters/:id`. That is three
 * round trips instead of one, and it is the point: a 10MB image per character
 * has no business passing through a Next.js route handler.
 */

const declaredUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
});

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().max(60).optional(),
  description: z.string().max(600).optional(),
  appearancePrompt: z.string().min(20).max(APPEARANCE_PROMPT_MAX).optional(),
  voiceId: z.string().max(120).nullable().optional(),
  /**
   * What the client intends to upload. Claims, not facts — every one of them is
   * re-checked against the stored object at confirm time.
   */
  referenceImages: z.array(declaredUploadSchema).max(MAX_REFERENCE_IMAGES).optional(),
});

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'character.create', body: bodySchema },
  async ({ body, params, user }) => {
    const character = await createCharacter(user.id, params.id, body);

    // A character with no stills is a perfectly good character — the bible
    // generates a whole cast that way. References are added when the user has
    // them.
    const uploads =
      body.referenceImages && body.referenceImages.length > 0
        ? await issueReferenceUploads(user.id, character.id, body.referenceImages)
        : [];

    return { character, uploads };
  },
);
