import { z } from 'zod';
import { dynamicRoute } from '@/lib/api/handler';
import { issueReferenceUploads } from '@/lib/data/characters';
import { MAX_REFERENCE_IMAGES } from '@/lib/characters/references';

/**
 * Signed upload URLs for reference stills on an existing character.
 *
 * One URL per file, each for a path this server chose. The response is a set of
 * capabilities to write exactly those objects and nothing else — which is why
 * the client never gets to name the path.
 *
 * Nothing is recorded until `PATCH /api/characters/:id` confirms the uploads and
 * the server inspects what actually landed.
 */

const bodySchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1).max(100),
        bytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(MAX_REFERENCE_IMAGES),
});

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'character.references.upload_urls', body: bodySchema },
  async ({ body, params, user }) => {
    const uploads = await issueReferenceUploads(user.id, params.id, body.files);
    return { uploads };
  },
);
