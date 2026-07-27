import { Suspense } from 'react';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { SpendMeter, SpendMeterSkeleton } from '@/components/shell/spend-meter';
import { requireUser } from '@/lib/auth';

/** Session state must never be cached across users. */
export const dynamic = 'force-dynamic';

/**
 * The shell blocks on exactly one thing: knowing who the user is.
 *
 * It used to also await the monthly spend summary — a `withUserDb` transaction
 * measured at 190-490ms — before rendering anything, so every route in the app
 * paid for a header widget before its own content could begin. The meter streams
 * now, and nothing below the header depends on it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={user.email ?? 'signed in'}
          spend={
            <Suspense fallback={<SpendMeterSkeleton />}>
              <SpendMeter userId={user.id} />
            </Suspense>
          }
        />
        <main className="min-w-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
