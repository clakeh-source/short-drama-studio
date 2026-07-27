import { Skeleton } from '@/components/ui/skeleton';

export default function AppLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    </div>
  );
}
