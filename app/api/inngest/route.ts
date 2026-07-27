import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { functions } from '@/lib/inngest/functions';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

/**
 * Inngest runs every step as its own HTTP request to this endpoint, so the
 * ceiling here is the ceiling on the slowest single step — `ingestFromUrl`,
 * which pulls a finished clip off the provider's CDN and pushes it into Supabase
 * Storage. On Vercel's 15s Pro default that step dies part-way through, and
 * because the job is durable it is retried and dies again.
 *
 * 300s is the Vercel Pro maximum. See docs/DEPLOY.md.
 */
export const maxDuration = 300;
