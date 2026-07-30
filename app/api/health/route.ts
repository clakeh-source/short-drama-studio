import { NextResponse } from 'next/server';
import { route } from '@/lib/api/handler';
import { healthReport } from '@/lib/health';

/**
 * Liveness/readiness for the app and its dependencies.
 *
 * Public — an uptime probe has no session, and the payload is deliberately free
 * of anything sensitive: statuses, latencies, and failure messages that name a
 * dependency but never a credential.
 *
 * `force-dynamic` because the whole point is the state right now; a cached
 * health check reports the state of whenever it was built.
 */
export const dynamic = 'force-dynamic';

export const GET = route({ operation: 'health', auth: false }, async () => {
  const report = await healthReport();

  // 503 when a dependency is down, so a load balancer or uptime monitor reacts
  // without having to parse the body.
  return NextResponse.json(report, { status: report.status === 'down' ? 503 : 200 });
});
