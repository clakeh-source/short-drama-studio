import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Supabase-managed schemas are none of our business; never diff or drop them.
  schemaFilter: ['public'],
  entities: {
    roles: {
      provider: 'supabase',
    },
  },
  verbose: true,
  strict: true,
});
