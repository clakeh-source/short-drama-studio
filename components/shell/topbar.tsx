import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface TopbarProps {
  email: string;
  /**
   * The spend readout, passed in as a node so the layout can stream it behind a
   * Suspense boundary. It used to be four resolved props, which meant the header
   * — and therefore the whole page — waited on a database round trip.
   */
  spend: React.ReactNode;
}

export function Topbar({ email, spend }: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <div className="flex items-center gap-3">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">This month</span>
        {spend}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{email}</span>
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="ghost" size="icon" aria-label="Sign out">
            <LogOut />
          </Button>
        </form>
      </div>
    </header>
  );
}
