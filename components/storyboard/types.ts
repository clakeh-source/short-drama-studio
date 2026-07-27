/** Serialisable shapes the storyboard page hands to the client workspace. */

export interface BoardCharacter {
  id: string;
  name: string;
  role: string;
  appearancePrompt: string;
}

/**
 * Deliberately narrower than the `shots` row.
 *
 * Everything here crosses the network twice — once as HTML, once in the RSC
 * payload for hydration — for every shot in the episode, whether or not its card
 * is rendered. Three fields used to ride along unread:
 *
 * - `videoPrompt` (6.7 KB across twenty shots) — the card recomposes the prompt
 *   live from the current edits with the same pure function the server persists
 *   with, so the stored copy was never read. Sending it also risked showing a
 *   stale prompt next to an unsaved edit.
 * - `negativePrompt` (4.0 KB, and exactly *one* distinct value) — series-level,
 *   not per-shot. It is now passed once on the workspace.
 * - `sceneId` — only ever written, never read; which scene a shot belongs to is
 *   the tree structure, not a field.
 */
export interface BoardShot {
  id: string;
  orderIndex: number;
  durationSeconds: number;
  camera: string;
  action: string;
  dialogue: string | null;
  speakerCharacterId: string | null;
  characterIds: string[];
  promptOverride: string | null;
  status: string;
}

export interface BoardScene {
  id: string;
  orderIndex: number;
  location: string;
  timeOfDay: string;
  shots: BoardShot[];
}

export interface BoardEstimate {
  videoCents: number;
  voiceCents: number;
  totalCents: number;
  shotCount: number;
  voiceShotCount: number;
  totalSeconds: number;
  providers: { video: string; tts: string };
}
