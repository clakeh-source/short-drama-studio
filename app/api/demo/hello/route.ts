import { z } from 'zod';
import { route } from '@/lib/api/handler';
import { inngest } from '@/lib/inngest/client';

const bodySchema = z.object({
  name: z.string().min(1).max(80).default('world'),
});

/**
 * Fires the hello-world Inngest event. Exists to verify Phase 0 AC #5 from
 * inside the running app, and to serve as the reference shape for every route
 * handler that follows: Zod on the input, `route()` for auth + logging.
 */
export const POST = route({ operation: 'demo.hello', body: bodySchema }, async ({ body, user }) => {
  const { ids } = await inngest.send({
    name: 'demo/hello.world',
    data: { name: body.name },
  });

  return { queued: true, eventIds: ids, requestedBy: user.id };
});
