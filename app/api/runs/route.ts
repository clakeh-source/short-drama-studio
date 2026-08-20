import { z } from 'zod';
import { paymentRequired, route } from '@/lib/api/handler';
import { withUserDb } from '@/lib/db';
import { runs } from '@/lib/db/schema';
import { listRuns } from '@/lib/data/runs';
import { estimateRun } from '@/lib/runs/estimate';
import { inngest } from '@/lib/inngest/client';
import { getImageProvider, getTtsProvider, getVideoProvider } from '@/lib/providers';
import { screenWithRules } from '@/lib/ai/safety';
import { checkSpend } from '@/lib/spend';
import { badRequest } from '@/lib/api/handler';

/**
 * Starts an unattended prompt-to-film run.
 *
 * The whole product in one request: a sentence and a target length go in, and
 * everything from the bible to the finished cut happens without another click.
 * The gates are what keep that from being reckless — see lib/data/runs.ts.
 */

/** Shortest worth attempting, and longest before the cost stops being a joke. */
const MIN_TARGET_SECONDS = 30;
const MAX_TARGET_SECONDS = 600;

const bodySchema = z.object({
  prompt: z.string().min(10, 'Give the film at least a sentence.').max(2000),
  /** Defaults to three minutes — long enough to be a film, short enough to afford. */
  targetSeconds: z.coerce.number().int().min(MIN_TARGET_SECONDS).max(MAX_TARGET_SECONDS).default(180),
  /** Skip the pre-flight refusal when the caller has already seen the number. */
  acceptEstimateCents: z.number().int().nonnegative().optional(),
});

export const POST = route<z.infer<typeof bodySchema>>(
  { operation: 'run.start', body: bodySchema },
  async ({ body, user }) => {
    // The same deterministic gate every generation path goes through. A premise
    // that cannot be filmed should fail here, not after the bible is written.
    const findings = screenWithRules(body.prompt);
    if (findings.length > 0) {
      throw badRequest(findings[0]!.message, { reasons: findings.map((f) => f.message) });
    }

    const estimate = estimateRun({
      targetSeconds: body.targetSeconds,
      video: getVideoProvider(),
      image: getImageProvider(),
      tts: getTtsProvider(),
    });

    // Checked against the *worst* case, not the expected one: a run that stops
    // two thirds of the way through for want of budget has spent the money and
    // produced nothing watchable.
    const spend = await checkSpend(user.id, estimate.maxCents);
    if (!spend.allowed) {
      throw paymentRequired(spend.message ?? 'This run would exceed your monthly spend cap.');
    }

    const [run] = await withUserDb(user.id, (tx) =>
      tx
        .insert(runs)
        .values({
          userId: user.id,
          prompt: body.prompt,
          targetSeconds: body.targetSeconds,
          estimateCents: estimate.totalCents,
          stage: 'bible',
          status: 'pending',
        })
        .returning(),
    );

    const { ids } = await inngest.send({
      // One run per row; a double-clicked button cannot start two.
      id: `run-start:${run!.id}`,
      name: 'run/start.requested',
      data: { userId: user.id, runId: run!.id },
    });

    return { run, estimate, eventIds: ids };
  },
);

/** Recent runs, newest first. */
export const GET = route({ operation: 'run.list' }, async ({ user }) => ({
  runs: await listRuns(user.id),
}));
