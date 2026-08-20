import { dynamicRoute } from '@/lib/api/handler';
import { startAssembly } from '@/lib/data/assemble';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * The original name for assembly, kept because the export panel calls it.
 *
 * Identical behaviour to `/assemble` — same helper, same 409 when shots are
 * missing clips. Two names for one operation is a small wart; two
 * implementations of it would be a real one.
 */
export const POST = dynamicRoute<{ id: string }>(
  // The rate limit is main's, from the audit. The body it guarded now lives in
  // `startAssembly`, which /assemble shares — including the ownership check the
  // audit added, moved there with the rest of it.
  { operation: 'episode.render', rateLimit: RATE_LIMITS.job },
  async ({ params, user }) => startAssembly(user.id, params.id),
);
