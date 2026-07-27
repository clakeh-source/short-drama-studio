import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { dynamicRoute } from '@/lib/api/handler';
import { scriptSchema } from '@/lib/ai/schemas';
import { withUserDb } from '@/lib/db';
import { episodes } from '@/lib/db/schema';
import { loadEpisode } from '@/lib/data/series';
import { estimateScriptSeconds } from '@/lib/timing';

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  synopsis: z.string().max(600).optional(),
  /** Whole-script replacement from the per-beat editors. */
  script: scriptSchema.optional(),
});

/** Human edits to the script. The script editor writes through this. */
export const PATCH = dynamicRoute<{ id: string }, z.infer<typeof patchSchema>>(
  { operation: 'episode.update', body: patchSchema },
  async ({ body, params, user }) => {
    await loadEpisode(user.id, params.id);

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.synopsis !== undefined) updates.synopsis = body.synopsis;
    if (body.script !== undefined) {
      updates.script = body.script;
      updates.hook = body.script.hook;
      updates.cliffhanger = body.script.cliffhanger;
      updates.status = 'scripted';
    }

    if (Object.keys(updates).length === 0) return { updated: false };

    await withUserDb(user.id, (tx) =>
      tx.update(episodes).set(updates).where(eq(episodes.id, params.id)),
    );

    return {
      updated: true,
      ...(body.script
        ? { estimatedSeconds: Math.round(estimateScriptSeconds(body.script.scenes)) }
        : {}),
    };
  },
);

export const GET = dynamicRoute<{ id: string }>(
  { operation: 'episode.get' },
  async ({ params, user }) => loadEpisode(user.id, params.id),
);
