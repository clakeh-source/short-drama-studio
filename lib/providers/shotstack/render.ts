import type { ProviderResult, RenderInput, RenderProvider } from '../types';
import { configurationError, isRetryableStatus, ProviderRequestError } from '../types';
import { CAPTION_PRESETS, DEFAULT_CAPTION_STYLE_ID, FRAME_HEIGHT } from '../../captions';

/**
 * Shotstack render adapter — the default cloud implementation.
 *
 * Shotstack is a JSON-timeline render API: you POST an edit describing tracks
 * and clips, it returns a render id, and you poll until the output is hosted.
 * That maps directly onto `RenderProvider`, which is why it was chosen over a
 * service that expects you to upload a project file.
 *
 * Captions are emitted as `title` clips positioned to clear the platform safe
 * areas, styled to match the ffmpeg adapter's ASS output — so swapping
 * `RENDER_PROVIDER` changes where the work happens, not what comes out.
 */

const CENTS_PER_MINUTE = 20;

interface ShotstackClip {
  asset: Record<string, unknown>;
  start: number;
  length: number;
  position?: string;
  offset?: { x?: number; y?: number };
  width?: number;
  height?: number;
}

function apiBase(): string {
  const stage = process.env.SHOTSTACK_ENV?.trim() === 'v1' ? 'v1' : 'stage';
  return `https://api.shotstack.io/${stage}`;
}

function apiKey(): string {
  const key = process.env.SHOTSTACK_API_KEY;
  if (!key) {
    throw configurationError(
      'SHOTSTACK_API_KEY is not set. Set it, or use RENDER_PROVIDER=ffmpeg for local rendering.',
    );
  }
  return key;
}

export class ShotstackRenderProvider implements RenderProvider {
  readonly id = 'shotstack';

  estimateCostCents(input: RenderInput): number {
    const seconds = input.clips.reduce(
      (end, clip) => Math.max(end, clip.startAt + clip.durationSeconds),
      0,
    );
    return Math.max(1, Math.ceil((seconds / 60) * CENTS_PER_MINUTE));
  }

  /** The edit document. Exported so its shape can be asserted without network. */
  buildEdit(input: RenderInput): Record<string, unknown> {
    const style = CAPTION_PRESETS[DEFAULT_CAPTION_STYLE_ID]!;

    const videoTrack: ShotstackClip[] = [...input.clips]
      .sort((a, b) => a.startAt - b.startAt)
      .map((clip) => ({
        asset: { type: 'video', src: clip.url },
        start: clip.startAt,
        length: clip.durationSeconds,
        // Fill the vertical frame rather than letterboxing a landscape source.
        fit: 'cover',
      })) as ShotstackClip[];

    const voiceTrack: ShotstackClip[] = input.voiceTracks.map((track) => ({
      asset: { type: 'audio', src: track.url },
      start: track.startAt,
      length: Math.max(0.1, track.startAt), // replaced below; see note
    }));

    // Shotstack needs an explicit length per audio clip. We do not know the
    // measured duration here, so let each run to the end of the programme and
    // rely on the file ending naturally.
    const total = input.clips.reduce(
      (end, clip) => Math.max(end, clip.startAt + clip.durationSeconds),
      0,
    );
    for (const [i, track] of input.voiceTracks.entries()) {
      voiceTrack[i]!.length = Math.max(0.1, total - track.startAt);
    }

    const captionTrack: ShotstackClip[] = input.captions.map((cue) => ({
      asset: {
        type: 'title',
        text: style.uppercase ? cue.text.toUpperCase() : cue.text,
        style: 'future',
        size: 'large',
        color: '#ffffff',
        background: style.borderStyle === 3 ? '#000000' : 'transparent',
      },
      start: cue.startAt,
      length: Math.max(0.1, cue.endAt - cue.startAt),
      position: 'bottom',
      // Shotstack offsets are fractions of the frame. Lifting the caption by the
      // safe-area margin keeps it out of the platform's own UI.
      offset: { y: style.marginBottomPx / FRAME_HEIGHT },
    }));

    const tracks: Array<{ clips: ShotstackClip[] }> = [
      // Topmost first in Shotstack, so captions lead.
      ...(captionTrack.length > 0 ? [{ clips: captionTrack }] : []),
      { clips: videoTrack },
      ...(voiceTrack.length > 0 ? [{ clips: voiceTrack }] : []),
      ...(input.musicUrl
        ? [
            {
              clips: [
                {
                  asset: { type: 'audio', src: input.musicUrl, volume: 0.18 },
                  start: 0,
                  length: total,
                },
              ] as ShotstackClip[],
            },
          ]
        : []),
    ];

    return {
      timeline: { background: '#000000', tracks },
      output: {
        format: 'mp4',
        fps: 30,
        size: { width: 1080, height: 1920 },
        // H.264 + AAC is Shotstack's mp4 default; stated explicitly so a change
        // in their defaults cannot silently alter the deliverable.
        quality: 'high',
      },
    };
  }

  async render(input: RenderInput): Promise<{ providerJobId: string }> {
    if (input.clips.length === 0) {
      // A timeline with no clips is a caller bug, not a transient fault; the
      // same call will produce the same empty timeline every time.
      throw configurationError('Nothing to render — the timeline has no clips.');
    }

    const response = await fetch(`${apiBase()}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey() },
      body: JSON.stringify(this.buildEdit(input)),
    });

    const payload = (await response.json().catch(() => null)) as
      | { success?: boolean; response?: { id?: string }; message?: string }
      | null;

    if (!response.ok || !payload?.response?.id) {
      // Classified by status like every other adapter: a 402 or a 401 will be
      // refused identically next time, while a 5xx is worth another go.
      throw new ProviderRequestError(
        `Shotstack refused the render (${response.status}): ${payload?.message ?? 'no detail'}`,
        { retryable: isRetryableStatus(response.status), status: response.status },
      );
    }

    return { providerJobId: payload.response.id };
  }

  async poll(providerJobId: string): Promise<ProviderResult> {
    const response = await fetch(`${apiBase()}/render/${providerJobId}`, {
      headers: { 'x-api-key': apiKey() },
    });

    if (!response.ok) {
      return {
        status: 'failed',
        error: `Shotstack status check failed (${response.status}).`,
        // 5xx and rate limits are worth another go; a 4xx is not.
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    const payload = (await response.json()) as {
      response?: { status?: string; url?: string; error?: string; duration?: number };
    };

    const status = payload.response?.status;

    if (status === 'done' && payload.response?.url) {
      return {
        status: 'ready',
        url: payload.response.url,
        costCents: Math.max(1, Math.ceil(((payload.response.duration ?? 0) / 60) * CENTS_PER_MINUTE)),
        meta: { adapter: 'shotstack', durationSeconds: payload.response.duration ?? null },
      };
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        error: payload.response?.error ?? 'Shotstack reported the render as failed.',
        retryable: true,
      };
    }

    return { status: 'pending' };
  }
}
