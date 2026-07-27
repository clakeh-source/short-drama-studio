'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function AppError({
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
        message: 'app route error',
        ts: new Date().toISOString(),
        error: error.message,
        digest: error.digest,
      }),
    );
  }, [error]);

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="p-8 text-center">
        <AlertTriangle className="mx-auto mb-4 size-7 text-destructive" />
        <h2 className="font-semibold">This screen failed to load</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <Button className="mt-6" variant="outline" onClick={reset}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
