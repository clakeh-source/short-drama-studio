import { Skeleton } from '@/components/ui/skeleton';

/**
 * Mirrors the Library's real layout — a 9:16 tile grid — so the page does not
 * jump when the episodes arrive.
 */
export default function LibraryLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="flex items-center gap-2">
        <Skeleton className="h-7 w-16 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="ml-auto h-8 w-28" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border p-0">
            <Skeleton className="h-72 w-full rounded-b-none" />
            <div className="space-y-2 p-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
