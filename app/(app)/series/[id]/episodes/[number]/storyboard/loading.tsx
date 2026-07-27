import { Skeleton } from '@/components/ui/skeleton';

/**
 * The storyboard is the heaviest page in the app — twenty shot cards, each with
 * a 9:16 frame — so it is the one where a matching skeleton matters most.
 */
export default function StoryboardLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Cost panel */}
      <Skeleton className="h-40" />

      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-36" />
      </div>

      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border border-border p-3">
            <Skeleton className="h-40 w-24 shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
