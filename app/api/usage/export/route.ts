import { dynamicRoute } from '@/lib/api/handler';
import { loadUsageCsv } from '@/lib/data/usage-report';

/**
 * The usage ledger as a CSV download.
 *
 * Returns a Response rather than a value so the handler can set the content type
 * and filename; everything else in the app returns JSON.
 */
export const GET = dynamicRoute(
  { operation: 'usage.export' },
  async ({ user }) => {
    const csv = await loadUsageCsv(user.id);
    const stamp = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        // `charset` matters: series titles may be non-ASCII.
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="short-drama-usage-${stamp}.csv"`,
        // A spend report must never be served from a cache.
        'cache-control': 'no-store',
      },
    });
  },
);
