import { log } from '@/lib/log';
import { inngest } from '../client';

/**
 * Smoke test for the background-job pipeline. Two steps, so the Inngest dev
 * server shows real step boundaries and durable state, not just an invocation.
 */
export const helloWorld = inngest.createFunction(
  { id: 'hello-world', name: 'Hello world' },
  { event: 'demo/hello.world' },
  async ({ event, step }) => {
    const greeting = await step.run('compose-greeting', async () => {
      return `Hello, ${event.data.name}!`;
    });

    await step.sleep('brief-pause', '1s');

    const result = await step.run('record', async () => {
      log.info('hello-world executed', { operation: 'inngest.hello-world', greeting });
      return { greeting, completedAt: new Date().toISOString() };
    });

    return result;
  },
);
