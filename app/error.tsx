'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'unhandled render error',
        ts: new Date().toISOString(),
        error: error.message,
        digest: error.digest,
      }),
    );
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <AlertTriangle className="mx-auto mb-4 size-8 text-destructive" />
        <h1 className="text-lg font-semibold">Something broke</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || 'An unexpected error occurred.'}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">digest {error.digest}</p>
        ) : null}
        <Button className="mt-6" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
