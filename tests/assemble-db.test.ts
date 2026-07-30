import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { assets, episodes, renders, scenes, series, shots } from '@/lib/db/schema';
import { startAssembly } from '@/lib/data/assemble';
import { setStorageProvider } from '@/lib/storage';
import type { ListedObject, ObjectStat, StorageProvider, StoredObject } from '@/lib/storage';

/**
 * Phase 5 AC #2 — assembling an incomplete episode is refused, and says which
 * shots are blocking it.
 *
 * The important half of this is the *negative* assertion: no render row, no
 * queued job, no partial file. A half-episode encodes perfectly well and is
 * indistinguishable from a finished one at the file level, so "it refused" has
 * to mean nothing happened rather than nothing finished.
 *
 * Requires DATABASE_URL and `pnpm db:migrate`.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

/** Signs anything; the timeline only needs URLs to exist. */
class FakeStorage implements StorageProvider {
  readonly id = 'fake';
  async upload(): Promise<StoredObject> {
    throw new Error('not used');
  }
  async delete(): Promise<void> {}
  async getSignedUrl(path: string): Promise<string | null> {
    return `https://signed.test/${path}`;
  }
  async getSignedUrls(paths: readonly string[]): Promise<Map<string, string>> {
    return new Map(paths.map((p) => [p, `https://signed.test/${p}`]));
  }
  async createUploadUrl(): Promise<never> {
    throw new Error('not used');
  }
  async stat(): Promise<ObjectStat | null> {
    return null;
  }
  async list(): Promise<ListedObject[]> {
    return [];
  }
}

const userId = crypto.randomUUID();
let episodeId: string;
let shotIds: string[];

/** An episode of four shots; `readyCount` of them have a stored clip. */
async function board(readyCount: number): Promise<void> {
  await db().delete(series).where(eq(series.userId, userId));

  const [s] = await db()
    .insert(series)
    .values({ userId, title: 'Assemble: The Last Ferry', logline: '' })
    .returning({ id: series.id });

  const [ep] = await db()
    .insert(episodes)
    .values({ seriesId: s!.id, number: 1, title: 'Manifest' })
    .returning({ id: episodes.id });
  episodeId = ep!.id;

  const [sc] = await db()
    .insert(scenes)
    .values({ episodeId, orderIndex: 0, location: 'Terminal', timeOfDay: 'night' })
    .returning({ id: scenes.id });

  const rows = await db()
    .insert(shots)
    .values(
      Array.from({ length: 4 }, (_, i) => ({
        sceneId: sc!.id,
        orderIndex: i,
        durationSeconds: 5,
        camera: 'medium',
        action: `Beat ${i}`,
        videoPrompt: `A medium shot. Beat ${i}.`,
        status: (i < readyCount ? 'ready' : 'pending') as 'ready' | 'pending',
      })),
    )
    .returning({ id: shots.id });

  shotIds = rows.map((r) => r.id);

  for (let i = 0; i < readyCount; i++) {
    await db()
      .insert(assets)
      .values({
        shotId: shotIds[i]!,
        episodeId,
        kind: 'video',
        provider: 'stub',
        version: 1,
        status: 'ready',
        storagePath: `clips/${userId}/${episodeId}/shots/${shotIds[i]}/v1/a0.mp4`,
        durationSeconds: 5,
        meta: { attempt: 0, version: 1 },
      });
  }
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as {
      status?: number;
      code?: string;
      message?: string;
      details?: { incompleteShotIds?: string[] };
      incompleteShotIds?: string[];
    };
    return e;
  }
  throw new Error('Expected the assembly to be refused, but it started.');
}

describe.skipIf(!hasDatabase)('assembling an episode', () => {
  beforeEach(() => {
    setStorageProvider(new FakeStorage());
  });

  afterAll(async () => {
    setStorageProvider(null);
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('AC #2 — refuses with 409 and names every incomplete shot', async () => {
    await board(2);

    const error = await refusal(startAssembly(userId, episodeId));

    // 409, not 400: nothing about the request is malformed, the episode is
    // simply not in a state where this can happen yet.
    expect(error.status).toBe(409);
    expect(error.code).toBe('episode_not_ready');
    expect(error.message).toMatch(/2 of 4 shots have no clip/);

    // The two that are actually blocking, and only those.
    expect(error.incompleteShotIds?.sort()).toEqual([shotIds[2]!, shotIds[3]!].sort());
    expect(error.details?.incompleteShotIds?.sort()).toEqual([shotIds[2]!, shotIds[3]!].sort());
  });

  it('produces no render row and no partial file', async () => {
    await board(2);

    await refusal(startAssembly(userId, episodeId));

    // The whole point of refusing before submitting: nothing was started, so
    // there is nothing half-finished to clean up or to mistake for a result.
    expect(await db().select().from(renders).where(eq(renders.episodeId, episodeId))).toHaveLength(
      0,
    );

    const [episode] = await db().select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.status).not.toBe('rendered');
    expect(episode!.outputStoragePath).toBeNull();
    expect(episode!.durationSeconds).toBeNull();
  });

  it('says so plainly when nothing has been generated at all', async () => {
    await board(0);

    const error = await refusal(startAssembly(userId, episodeId));

    expect(error.status).toBe(409);
    expect(error.message).toMatch(/nothing to assemble/);
    expect(error.incompleteShotIds).toHaveLength(4);
  });

  it('starts once every shot has a clip', async () => {
    await board(4);

    const result = await startAssembly(userId, episodeId);

    expect(result.queued).toBe(true);
    expect(result.clipCount).toBe(4);
    expect(result.totalSeconds).toBe(20);
  });

  it('refuses a shot whose clip is missing from storage, even if it says ready', async () => {
    await board(4);
    // A `ready` shot with no asset row: the status and the storage disagree,
    // and the storage is the one that decides whether there is a video.
    await db().delete(assets).where(eq(assets.shotId, shotIds[1]!));

    const error = await refusal(startAssembly(userId, episodeId));

    expect(error.status).toBe(409);
    expect(error.incompleteShotIds).toEqual([shotIds[1]!]);
  });
});

describe.skipIf(hasDatabase)('assemble suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('Skipped: set DATABASE_URL and run `pnpm db:migrate` to execute these.');
    expect(hasDatabase).toBe(false);
  });
});
