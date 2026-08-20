import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';

/**
 * `POST /api/episodes/[id]/render` — ownership before anything else.
 *
 * The bug this pins: the route asked `activeRender(episodeId)` first, and that
 * query runs on the privileged handle and takes no user id, because it is
 * written for the job side. So rendering someone else's episode id answered
 * "A render is already running for this episode", with their render's id in the
 * body — a cross-tenant answer from an endpoint that should have none.
 */

const user = { id: 'user-1', email: 'dev@example.test' };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@/lib/auth');
  return { ...actual, requireApiUser: vi.fn(async () => user) };
});

vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const activeRender = vi.fn();
const buildEpisodeTimeline = vi.fn();
const listRenders = vi.fn(async () => []);
const loadEpisode = vi.fn();

vi.mock('@/lib/data/render', () => ({ activeRender, buildEpisodeTimeline, listRenders }));

vi.mock('@/lib/data/series', () => ({ loadEpisode }));

vi.mock('@/lib/spend', () => ({
  checkSpend: vi.fn(async () => ({
    allowed: true,
    spentCents: 0,
    capCents: 2_000,
    requestedCents: 0,
    remainingCents: 2_000,
  })),
}));

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: ['event-1'] })) },
  episodeRenderEventId: (episodeId: string, attempt: number) => `${episodeId}:${attempt}`,
}));

const { POST } = await import('@/app/api/episodes/[id]/render/route');
const { notFound } = await import('@/lib/api/handler');

function post(id = 'episode-1') {
  return [
    new Request(`http://test.local/api/episodes/${id}/render`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

/** An episode with every shot generated, ready to render. */
function readyTimeline() {
  return {
    timeline: {
      clips: [{ shotId: 'shot-1', startAt: 0, durationSeconds: 5 }],
      voiceTracks: [],
      captions: [],
      aspectRatio: '9:16' as const,
      resolution: '1080x1920' as const,
      totalSeconds: 5,
    },
    readiness: { ready: true, blockingShots: [], shotCount: 1, clipCount: 1 },
    captionStyleId: 'default',
    seriesId: 'series-1',
    episodeNumber: 1,
    episodeTitle: 'One',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadEpisode.mockResolvedValue({ episode: { id: 'episode-1' }, series: { id: 'series-1' } });
  buildEpisodeTimeline.mockResolvedValue(readyTimeline());
  activeRender.mockResolvedValue(null);
  listRenders.mockResolvedValue([]);
});

describe('someone else’s episode', () => {
  it('is a 404, and is not asked about', async () => {
    loadEpisode.mockRejectedValue(notFound('Episode not found'));
    // Their episode does have a render running — the point is we never look.
    activeRender.mockResolvedValue({ id: 'their-render-id' });

    const response = await POST(...post('someone-elses-episode'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
    expect(activeRender, 'the privileged query must sit behind the ownership check').not.toHaveBeenCalled();
    expect(buildEpisodeTimeline).not.toHaveBeenCalled();
  });
});

describe('the owner', () => {
  it('is told when their own render is already running', async () => {
    activeRender.mockResolvedValue({ id: 'render-1' });

    const response = await POST(...post());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queued: false,
      renderId: 'render-1',
    });
    // Still the cheap path: no signed URLs are minted to say "already running".
    expect(buildEpisodeTimeline).not.toHaveBeenCalled();
  });

  it('queues a render when nothing is in flight', async () => {
    const response = await POST(...post());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ queued: true });
    expect(buildEpisodeTimeline).toHaveBeenCalledWith('user-1', 'episode-1');
  });
});
