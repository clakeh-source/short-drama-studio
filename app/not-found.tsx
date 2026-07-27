import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">That page does not exist</h1>
      <Button asChild variant="outline">
        <Link href="/series">Back to your series</Link>
      </Button>
    </div>
  );
}
