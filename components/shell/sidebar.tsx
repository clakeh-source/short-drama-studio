'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, Film, LibraryBig, Receipt, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  // First, because it is the whole product: everything below is for picking apart
  // what this made.
  { href: '/create', label: 'Create', icon: Sparkles },
  { href: '/series', label: 'Series', icon: Film },
  { href: '/library', label: 'Library', icon: LibraryBig },
  { href: '/usage', label: 'Usage', icon: Receipt },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-card/40 p-3"
    >
      <Link href="/series" className="mb-4 flex items-center gap-2 px-2 py-1.5">
        <Clapperboard className="size-5 text-primary" />
        <span className="text-sm font-semibold leading-tight">
          Short Drama
          <br />
          Studio
        </span>
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
