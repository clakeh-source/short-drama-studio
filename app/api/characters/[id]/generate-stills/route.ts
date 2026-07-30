import { z } from 'zod';
import { dynamicRoute, paymentRequired } from '@/lib/api/handler';
import { generateCharacterPortraits } from '@/lib/characters/portraits';
import { MAX_REFERENCE_IMAGES } from '@/lib/characters/references';
import { getImageProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';

/**
 * Generates a character's reference stills from their appearance prompt.
 *
 * The alternative to uploading photographs by hand, and the thing that lets an
 * unattended run produce characters with consistent faces rather than falling
 * back to text-to-video.
 *
 * Replaces the existing set rather than adding to it — see
 * `generateCharacterPortraits`.
 */
const bodySchema = z.object({
  count: z.int().min(1).max(MAX_REFERENCE_IMAGES).optional(),
});

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'character.portraits.generate', body: bodySchema },
  async ({ body, params, user }) => {
    const provider = getImageProvider();

    const estimateCents = provider.estimateCostCents({
      prompt: '',
      count: body.count ?? 3,
      aspectRatio: '9:16',
    });

    const spend = await checkSpend(user.id, estimateCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This would exceed your monthly spend cap.');
    }

    const result = await generateCharacterPortraits(user.id, params.id, {
      ...(body.count !== undefined ? { count: body.count } : {}),
    });

    return { ...result, provider: provider.id };
  },
);

/** Three diffusion images in series runs past the default ceiling. */
export const maxDuration = 300;
