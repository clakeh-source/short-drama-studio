import { dynamicRoute } from '@/lib/api/handler';
import { buildRendersPayload } from '@/lib/data/render';

/** Render history plus current readiness. Polled by the export panel. */
export const GET = dynamicRoute<{ id: string }>(
  { operation: 'episode.renders' },
  ({ params, user }) => buildRendersPayload(user.id, params.id),
);
