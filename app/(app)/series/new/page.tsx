import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { NewSeriesStart } from '@/components/series/new-series-start';
import { requireUser } from '@/lib/auth';

export const metadata = { title: 'New series · Short Drama Studio' };
export const dynamic = 'force-dynamic';

export default async function NewSeriesPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href="/series"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Series
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New series</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a premise and let the model write it, or bring a script you already have.
          Either way you review every stage.
        </p>
      </div>

      <NewSeriesStart />
    </div>
  );
}
