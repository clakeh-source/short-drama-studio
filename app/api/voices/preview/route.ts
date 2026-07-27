import { z } from 'zod';
import { dynamicRoute, badRequest } from '@/lib/api/handler';
import { getTtsProvider } from '@/lib/providers';
import { checkSpend } from '@/lib/spend';
import { recordUsage } from '@/lib/usage';
import { log } from '@/lib/log';

/**
 * Auditions one voice.
 *
 * This is a real provider call that costs real money, so it carries the same
 * guards as any other generation: the monthly cap is checked first and the charge
 * is written to `usage_log`.
 *
 * The audio comes back as bytes rather than a storage URL — an audition is
 * throwaway, and writing every one to a bucket would leave litter nothing cleans
 * up.
 *
 * The line is a fixed constant, not a parameter. An earlier draft accepted
 * caller-supplied text, which made this a general-purpose speech synthesis
 * endpoint that no part of the UI needed; the deterministic safety rules screen
 * framings and offices rather than arbitrary names, so free text here would have
 * been the least-guarded paid call in the app. Auditioning a voice does not
 * require choosing the words.
 */

const bodySchema = z.object({
  voiceId: z.string().min(1).max(120),
});

/**
 * Reads naturally in most voices, carries some emotion, and stays cheap.
 *
 * Not exported: Next only permits a route module to export route handlers and a
 * fixed set of config keys, and anything else fails the build's type check.
 */
const AUDITION_LINE = 'You told me he was dead. I saw the signature myself.';

export const POST = dynamicRoute<Record<string, never>, z.infer<typeof bodySchema>>(
  { operation: 'voice.preview', body: bodySchema },
  async ({ body, user }) => {
    const provider = getTtsProvider();

    const estimateCents = provider.estimateCostCents(AUDITION_LINE);
    const spend = await checkSpend(user.id, estimateCents);
    if (!spend.allowed) {
      throw badRequest(spend.message ?? 'This would take you past your monthly spend cap.');
    }

    const started = Date.now();
    const { audio, durationSeconds } = await provider.synthesize({
      text: AUDITION_LINE,
      voiceId: body.voiceId,
    });

    await recordUsage({
      userId: user.id,
      provider: provider.id,
      operation: 'voice.preview',
      costCents: estimateCents,
    });

    log.info('voice auditioned', {
      userId: user.id,
      provider: provider.id,
      operation: 'voice.preview',
      durationMs: Date.now() - started,
      costCents: estimateCents,
    });

    return new Response(new Uint8Array(audio), {
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(audio.byteLength),
        // Auditions are transient and each one is charged; never cache one.
        'cache-control': 'no-store',
        'x-audio-seconds': durationSeconds.toFixed(2),
      },
    });
  },
);

/**
 * Blocks on a live TTS synthesis — ~3s for a short line against ElevenLabs, but
 * a long one and a cold provider can push past Vercel's 15s Pro default. 60s is
 * generous for one line and still fails fast if the provider hangs.
 */
export const maxDuration = 60;
