/**
 * Whether Inngest is talking to a local dev server or to the cloud.
 *
 * This exists because the SDK's own answer is inferred, and infers *open*.
 * `getMode` in the SDK reads the deployment as "cloud" only when it recognises
 * a production marker — `NODE_ENV`/`VERCEL_ENV`/`CONTEXT`/`ENVIRONMENT` starting
 * with `prod`, or a Netlify/Render/Railway/Cloudflare/Deno variable — and
 * anything it does not recognise it calls dev. In dev mode `validateSignature`
 * returns success without looking at the request.
 *
 * On Vercel the inference holds. Anywhere else it does not: a self-hosted Node
 * process started without `NODE_ENV=production`, a plain container, a preview
 * box. `/api/inngest` is a public path — it has to be, Inngest calls it — and it
 * invokes the job functions, which read and write through the RLS-bypassing
 * database handle with the `userId` from the event body. An unauthenticated
 * caller reaching that is not something to leave to environment sniffing.
 *
 * So the polarity is inverted: cloud unless this is *positively known* to be a
 * dev machine. `next dev` sets `NODE_ENV=development`, which covers the
 * documented local workflow with no extra configuration; `INNGEST_DEV=1` is the
 * SDK's own opt-in and is honoured for anyone running the dev server another
 * way. Everything else must present a signing key.
 */
export function inngestIsDev(): boolean {
  return process.env.INNGEST_DEV === '1' || process.env.NODE_ENV === 'development';
}
