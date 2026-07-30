import { dynamicRoute } from '@/lib/api/handler';
import { startAssembly } from '@/lib/data/assemble';

/**
 * The original name for assembly, kept because the export panel calls it.
 *
 * Identical behaviour to `/assemble` — same helper, same 409 when shots are
 * missing clips. Two names for one operation is a small wart; two
 * implementations of it would be a real one.
 */
export const POST = dynamicRoute<{ id: string }>(
  { operation: 'episode.render' },
  async ({ params, user }) => startAssembly(user.id, params.id),
);
