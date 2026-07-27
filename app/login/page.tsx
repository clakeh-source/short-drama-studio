import { LoginForm } from '@/components/auth/login-form';

export const metadata = { title: 'Sign in · Short Drama Studio' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8">
        <LoginForm next={next} />
      </div>
    </main>
  );
}
