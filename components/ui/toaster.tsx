'use client';

import { Toaster as Sonner } from 'sonner';

/**
 * App-wide toast surface. Import { toast } from 'sonner' anywhere on the client.
 */
export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: 'border-border bg-card text-card-foreground',
        },
      }}
    />
  );
}
