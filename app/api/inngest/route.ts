import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { functions } from '@/lib/inngest/functions';

/**
 * Signature verification is what makes this public endpoint safe to expose, and
 * whether the SDK performs it at all depends on the client's mode — stated in
 * lib/inngest/client.ts rather than inferred. lib/env.ts refuses to start
 * without a signing key anywhere that mode is not dev.
 */
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
