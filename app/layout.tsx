import type { Metadata, Viewport } from 'next';
import { Toaster } from '@/components/ui/toaster';
import './globals.css';

export const metadata: Metadata = {
  title: 'Short Drama Studio',
  description: 'Turn a one-line premise into a finished vertical short-drama episode.',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
