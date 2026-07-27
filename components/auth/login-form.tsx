'use client';

import { useState } from 'react';
import { Clapperboard, Loader2, MailCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    try {
      const supabase = createClient();
      const redirectTo = new URL('/auth/callback', window.location.origin);
      if (next) redirectTo.searchParams.set('next', next);

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo.toString() },
      });

      if (error) {
        toast.error(error.message);
        return;
      }
      setSent(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send the link.');
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="text-center">
        <MailCheck className="mx-auto mb-4 size-8 text-[var(--success)]" />
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a sign-in link to <span className="text-foreground">{email}</span>. It expires in
          an hour.
        </p>
        <Button variant="ghost" className="mt-6" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="text-center">
        <Clapperboard className="mx-auto mb-4 size-8 text-primary" />
        <h1 className="text-xl font-semibold">Short Drama Studio</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with a magic link. No password to remember.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending || !email}>
        {pending ? <Loader2 className="animate-spin" /> : null}
        {pending ? 'Sending…' : 'Send magic link'}
      </Button>
    </form>
  );
}
