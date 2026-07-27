import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Provider stubs sleep 2s by design; RLS tests hit a real database.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '.'),
      // `server-only` throws unless the bundler picks its react-server export.
      // Vitest runs plain Node, so point it at a no-op; the guard still does
      // its job in the real Next build, which is where it matters.
      'server-only': resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
    },
  },
});
