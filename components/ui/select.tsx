import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A native <select> styled to match the rest of the kit. Deliberately not the
 * Radix listbox: these are short, plain option lists, and the native control is
 * keyboard- and screen-reader-correct for free.
 */
function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        className={cn(
          'flex h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 py-1 pr-8 text-sm shadow-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-popover',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { Select };
