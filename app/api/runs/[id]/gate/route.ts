import { z } from 'zod';
import { badRequest, dynamicRoute } from '@/lib/api/handler';
import { loadRun, updateRun } from '@/lib/data/runs';
import { inngest } from '@/lib/inngest/client';

/**
 * Answers the question a gate is asking.
 *
 * `continue` skips the rest of the countdown; `stop` ends the run and leaves
 * everything generated so far in place, editable by hand from the review board.
 * Doing nothing is also an answer — the countdown expires and the run continues,
 * which is what makes this optional rather than a checkpoint.
 */
const bodySchema = z.object({
  action: z.enum(['continue', 'stop']),
});

export const POST = dynamicRoute<{ id: string }, z.infer<typeof bodySchema>>(
  { operation: 'run.gate', body: bodySchema },
  async ({ body, params, user }) => {
    const run = await loadRun(user.id, params.id);

    if (run.status !== 'awaiting_gate') {
      throw badRequest(
        run.status === 'running'
          ? 'This run is already past that gate.'
          : `This run is ${run.status} — there is no gate to answer.`,
      );
    }

    // Told to the supervisor, which is blocked on exactly this event. Writing the
    // row alone would not wake it, and it would continue when the clock ran out.
    await inngest.send({
      name: 'run/gate.resolved',
      data: { userId: user.id, runId: params.id, action: body.action },
    });

    if (body.action === 'stop') {
      // Recorded here as well as by the supervisor, so the UI reflects the click
      // immediately rather than after the next poll finds the function awake.
      await updateRun(params.id, { status: 'cancelled', gateExpiresAt: null });
    }

    return { acknowledged: true, action: body.action, stage: run.stage };
  },
);
