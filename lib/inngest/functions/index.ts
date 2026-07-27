import { helloWorld } from './hello-world';
import { generateEpisodeAssets } from './generate-episode';
import { generateShotVideo } from './generate-shot-video';
import { generateShotVoice } from './generate-shot-voice';
import { renderEpisode } from './render-episode';

/** Every Inngest function must be listed here to be served by /api/inngest. */
export const functions = [
  helloWorld,
  generateEpisodeAssets,
  generateShotVideo,
  generateShotVoice,
  renderEpisode,
];
