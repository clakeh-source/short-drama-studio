import { dynamicRoute } from '@/lib/api/handler';
import { getTtsProvider } from '@/lib/providers';

/**
 * The TTS voice catalogue.
 *
 * Proxied through the server because listing voices is a provider call and the
 * provider key must never reach a client component.
 */
export const GET = dynamicRoute({ operation: 'voices.list' }, async () => {
  const provider = getTtsProvider();
  return { provider: provider.id, voices: await provider.listVoices() };
});
