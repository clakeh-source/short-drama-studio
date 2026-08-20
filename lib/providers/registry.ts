import type {
  ImageProvider,
  LlmProvider,
  RenderProvider,
  TtsProvider,
  VideoProvider,
} from './types';
import { AnthropicLlmProvider } from './anthropic/llm';
import { ElevenLabsTtsProvider } from './elevenlabs/tts';
import { FalImageProvider } from './fal/image';
import { FalVideoProvider } from './fal/video';
import { StubImageProvider } from './stub/image';
import { FfmpegRenderProvider } from './ffmpeg/render';
import { ReplicateVideoProvider } from './replicate/video';
import { ShotstackRenderProvider } from './shotstack/render';
import { StubLlmProvider } from './stub/llm';
import { StubRenderProvider } from './stub/render';
import { StubTtsProvider } from './stub/tts';
import { StubVideoProvider } from './stub/video';

/**
 * id → factory. Registering a provider is a one-line change here plus its
 * adapter file; nothing outside /lib/providers ever learns the id exists.
 *
 * Factories are lazy so an adapter that needs credentials only reads them when
 * it is actually the selected provider — `pnpm build` must not require a
 * Replicate token to succeed.
 */
const llmRegistry: Record<string, () => LlmProvider> = {
  stub: () => new StubLlmProvider(),
  anthropic: () => new AnthropicLlmProvider(),
};

const videoRegistry: Record<string, () => VideoProvider> = {
  stub: () => new StubVideoProvider(),
  replicate: () => new ReplicateVideoProvider(),
  fal: () => new FalVideoProvider(),
};

const imageRegistry: Record<string, () => ImageProvider> = {
  stub: () => new StubImageProvider(),
  fal: () => new FalImageProvider(),
};

const ttsRegistry: Record<string, () => TtsProvider> = {
  stub: () => new StubTtsProvider(),
  elevenlabs: () => new ElevenLabsTtsProvider(),
};

const renderRegistry: Record<string, () => RenderProvider> = {
  stub: () => new StubRenderProvider(),
  shotstack: () => new ShotstackRenderProvider(),
  ffmpeg: () => new FfmpegRenderProvider(),
};

function resolve<T>(
  registry: Record<string, () => T>,
  requested: string | undefined,
  envVar: string,
): T {
  const id = requested?.trim() || 'stub';
  const factory = registry[id];
  if (!factory) {
    throw new Error(
      `${envVar}="${id}" is not a registered provider. Available: ${Object.keys(registry).join(', ')}.`,
    );
  }
  return factory();
}

/**
 * Defaults to `anthropic` when a key is present and `stub` otherwise, so a
 * fresh clone with no credentials still runs the whole pipeline.
 */
export function getLlmProvider(id = process.env.LLM_PROVIDER): LlmProvider {
  const fallback = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'stub';
  return resolve(llmRegistry, id?.trim() || fallback, 'LLM_PROVIDER');
}

export function getVideoProvider(id = process.env.VIDEO_PROVIDER): VideoProvider {
  return resolve(videoRegistry, id, 'VIDEO_PROVIDER');
}

/**
 * Defaults to `fal` when a key is present and `stub` otherwise, matching the
 * LLM's rule: a fresh clone with no credentials still runs the whole pipeline.
 */
export function getImageProvider(id = process.env.IMAGE_PROVIDER): ImageProvider {
  const fallback = process.env.FAL_KEY ? 'fal' : 'stub';
  return resolve(imageRegistry, id?.trim() || fallback, 'IMAGE_PROVIDER');
}

export function getTtsProvider(id = process.env.TTS_PROVIDER): TtsProvider {
  return resolve(ttsRegistry, id, 'TTS_PROVIDER');
}

export function getRenderProvider(id = process.env.RENDER_PROVIDER): RenderProvider {
  return resolve(renderRegistry, id, 'RENDER_PROVIDER');
}

export function registeredProviderIds(): {
  llm: string[];
  video: string[];
  image: string[];
  tts: string[];
  render: string[];
} {
  return {
    llm: Object.keys(llmRegistry),
    video: Object.keys(videoRegistry),
    image: Object.keys(imageRegistry),
    tts: Object.keys(ttsRegistry),
    render: Object.keys(renderRegistry),
  };
}
