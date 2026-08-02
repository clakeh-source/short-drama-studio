import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import {
  assets,
  characterReferenceImages,
  characters,
  episodes,
  scenes,
  series,
  shots,
} from '@/lib/db/schema';
import {
  claimVideoSlot,
  KEEP_SHOT_VERSIONS,
  loadShotVersions,
  MAX_INFLIGHT_VIDEO_JOBS,
  pruneShotVersions,
  reconcileShotStatus,
  upsertAsset,
} from '@/lib/data/generation';
import { loadShotReferenceSet } from '@/lib/characters/reference-set';
import { CANONICAL_REFERENCE_SET_SIZE } from '@/lib/characters/references';
import { setStorageProvider } from '@/lib/storage';
import type { ListedObject, ObjectStat, StorageProvider, StoredObject } from '@/lib/storage';

/**
 * Phase 4 acceptance, against a real database.
 *
 * The concurrency cap and the version history are both properties of *rows under
 * contention*, not of any one function's return value, so neither can be shown
 * with mocks. Storage is stubbed — the object store's behaviour is already
 * covered in Phase 2 and what matters here is that pruning asks it to delete the
 * right keys.
 *
 * Requires DATABASE_URL and `pnpm db:migrate`. Skips rather than passing
 * vacuously without it.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

/** Records what pruning asked the store to delete, without deleting anything. */
class RecordingStorage implements StorageProvider {
  readonly id = 'recording';
  readonly deleted: string[] = [];

  async upload(): Promise<StoredObject> {
    throw new Error('not used');
  }
  async copy(): Promise<StoredObject> {
    throw new Error('not used');
  }
  async delete(paths: readonly string[]): Promise<void> {
    this.deleted.push(...paths);
  }
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
let storage: RecordingStorage;
let seriesId: string;
let episodeId: string;
let sceneId: string;
let shotId: string;
let meiId: string;

async function freshBoard(shotCount = 5): Promise<string[]> {
  await db().delete(series).where(eq(series.userId, userId));

  const [s] = await db()
    .insert(series)
    .values({ userId, title: 'Pipeline: The Last Ferry', logline: '' })
    .returning({ id: series.id });
  seriesId = s!.id;

  const [mei] = await db()
    .insert(characters)
    .values({ seriesId, name: 'Mei Lin', appearancePrompt: 'a woman in her thirties' })
    .returning({ id: characters.id });
  meiId = mei!.id;

  const [ep] = await db()
    .insert(episodes)
    .values({ seriesId, number: 1, title: 'Manifest' })
    .returning({ id: episodes.id });
  episodeId = ep!.id;

  const [sc] = await db()
    .insert(scenes)
    .values({ episodeId, orderIndex: 0, location: 'Terminal', timeOfDay: 'night' })
    .returning({ id: scenes.id });
  sceneId = sc!.id;

  const rows = await db()
    .insert(shots)
    .values(
      Array.from({ length: shotCount }, (_, i) => ({
        sceneId,
        orderIndex: i,
        durationSeconds: 5,
        camera: 'medium',
        action: `Beat ${i}`,
        videoPrompt: `A medium shot. Beat ${i}.`,
        characterIds: [meiId],
      })),
    )
    .returning({ id: shots.id });

  shotId = rows[0]!.id;
  return rows.map((r) => r.id);
}

/** Gives a character `count` canonical stills, as Phase 2's flow would. */
async function giveStills(characterId: string, count: number): Promise<void> {
  await db()
    .insert(characterReferenceImages)
    .values(
      Array.from({ length: count }, (_, i) => ({
        characterId,
        storagePath: `references/${userId}/${characterId}/${i}.png`,
        contentType: 'image/png',
        bytes: 1000,
        orderIndex: i,
        isCanonical: count >= CANONICAL_REFERENCE_SET_SIZE && i < CANONICAL_REFERENCE_SET_SIZE,
      })),
    );
}

describe.skipIf(!hasDatabase)('the generation pipeline, against the database', () => {
  beforeEach(async () => {
    storage = new RecordingStorage();
    setStorageProvider(storage);
    await freshBoard();
  });

  afterAll(async () => {
    setStorageProvider(null);
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  /* -- AC #1 ------------------------------------------------------------- */

  describe('AC #1 — reference sets reach the provider', () => {
    it('hands over the canonical set of every character in the shot', async () => {
      await giveStills(meiId, 4);

      const set = await loadShotReferenceSet([meiId]);

      // Four stills uploaded, three canonical — the fourth is history, not input.
      expect(set.urls).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
      expect(set.characters).toEqual([
        { id: meiId, name: 'Mei Lin', stills: CANONICAL_REFERENCE_SET_SIZE, urls: set.urls },
      ]);
      for (const url of set.urls) expect(url).toMatch(/^https:\/\//);
    });

    it('keeps each character’s stills grouped under them', async () => {
      const [daniel] = await db()
        .insert(characters)
        .values({ seriesId, name: 'Daniel Voss', appearancePrompt: 'a man in his forties' })
        .returning({ id: characters.id });

      await giveStills(meiId, 3);
      await giveStills(daniel!.id, 3);

      const set = await loadShotReferenceSet([meiId, daniel!.id]);

      // Six stills of two people, not one six-angle stranger. A model that holds
      // several identities has to be told which face is which, and the flat list
      // cannot express that — three angles of one person and one angle each of
      // three people are the same six URLs.
      const [mei, voss] = set.characters;
      expect(mei!.urls).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
      expect(voss!.urls).toHaveLength(CANONICAL_REFERENCE_SET_SIZE);
      for (const url of mei!.urls) expect(url).toContain(meiId);
      for (const url of voss!.urls) expect(url).toContain(daniel!.id);
    });

    it('flattens the groups in billing order, so the two views agree', async () => {
      const [daniel] = await db()
        .insert(characters)
        .values({ seriesId, name: 'Daniel Voss', appearancePrompt: 'a man in his forties' })
        .returning({ id: characters.id });

      await giveStills(meiId, 3);
      await giveStills(daniel!.id, 3);

      const set = await loadShotReferenceSet([meiId, daniel!.id]);

      // `urls` is derived from `characters`, so a caller that reads one and a
      // reviewer who reads the other are looking at the same request.
      expect(set.urls).toEqual(set.characters.flatMap((c) => c.urls));
      expect(set.characters.reduce((n, c) => n + c.stills, 0)).toBe(set.urls.length);
    });

    it('returns nothing for a character below the canonical threshold', async () => {
      await giveStills(meiId, 2);

      // Which is what makes the job fall back to text-to-video: conditioning on
      // a partial, inconsistent set is worse than conditioning on none.
      expect(await loadShotReferenceSet([meiId])).toEqual({ urls: [], characters: [] });
    });

    it('orders stills by the shot’s cast order, not the query’s', async () => {
      const [daniel] = await db()
        .insert(characters)
        .values({ seriesId, name: 'Daniel Voss', appearancePrompt: 'a man in his forties' })
        .returning({ id: characters.id });

      await giveStills(daniel!.id, 3);
      await giveStills(meiId, 3);

      // Mei is billed first, so hers is the still a single-image model gets.
      const set = await loadShotReferenceSet([meiId, daniel!.id]);

      expect(set.characters.map((c) => c.name)).toEqual(['Mei Lin', 'Daniel Voss']);
      expect(set.urls[0]).toContain(meiId);
    });

    it('returns nothing for a shot with no cast', async () => {
      expect(await loadShotReferenceSet([])).toEqual({ urls: [], characters: [] });
    });
  });

  /* -- AC #2 ------------------------------------------------------------- */

  describe('AC #2 — the concurrency cap holds under load', () => {
    it('admits three of five shots and refuses the rest', async () => {
      const shotIds = await db()
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));

      const claimed: boolean[] = [];
      for (const shot of shotIds) {
        const asset = await upsertAsset({
          shotId: shot.id,
          episodeId,
          kind: 'video',
          provider: 'stub',
          attempt: 0,
          version: 1,
        });
        claimed.push(await claimVideoSlot(seriesId, asset.id));
      }

      expect(claimed.filter(Boolean)).toHaveLength(MAX_INFLIGHT_VIDEO_JOBS);
      expect(claimed.slice(0, MAX_INFLIGHT_VIDEO_JOBS).every(Boolean)).toBe(true);

      // And the database agrees: never more than three actually in flight.
      const inflight = await db()
        .select()
        .from(assets)
        .where(and(eq(assets.episodeId, episodeId), eq(assets.status, 'generating')));
      expect(inflight).toHaveLength(MAX_INFLIGHT_VIDEO_JOBS);
    });

    it('holds when five shots claim concurrently, not just in sequence', async () => {
      const shotIds = await db()
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));

      const assetIds = await Promise.all(
        shotIds.map(async (shot) => {
          const asset = await upsertAsset({
            shotId: shot.id,
            episodeId,
            kind: 'video',
            provider: 'stub',
            attempt: 0,
            version: 1,
          });
          return asset.id;
        }),
      );

      // The race the advisory lock exists for: without it, several claims read
      // "two in flight" at once and all proceed to a third.
      const results = await Promise.all(assetIds.map((id) => claimVideoSlot(seriesId, id)));

      expect(results.filter(Boolean)).toHaveLength(MAX_INFLIGHT_VIDEO_JOBS);
    });

    it('frees a slot when a job finishes', async () => {
      const shotIds = await db()
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));

      const assetIds: string[] = [];
      for (const shot of shotIds) {
        const asset = await upsertAsset({
          shotId: shot.id,
          episodeId,
          kind: 'video',
          provider: 'stub',
          attempt: 0,
          version: 1,
        });
        assetIds.push(asset.id);
        await claimVideoSlot(seriesId, asset.id);
      }

      // The fourth was refused. Finish the first and it gets in.
      await db().update(assets).set({ status: 'ready' }).where(eq(assets.id, assetIds[0]!));

      expect(await claimVideoSlot(seriesId, assetIds[3]!)).toBe(true);
    });

    it('caps per project, so a second series is not starved by the first', async () => {
      const shotIds = await db()
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));

      for (const shot of shotIds.slice(0, MAX_INFLIGHT_VIDEO_JOBS)) {
        const asset = await upsertAsset({
          shotId: shot.id,
          episodeId,
          kind: 'video',
          provider: 'stub',
          attempt: 0,
          version: 1,
        });
        await claimVideoSlot(seriesId, asset.id);
      }

      // A different show, same account. The cap is per project by design.
      const [other] = await db()
        .insert(series)
        .values({ userId, title: 'Pipeline: Other show', logline: '' })
        .returning({ id: series.id });
      const [otherEp] = await db()
        .insert(episodes)
        .values({ seriesId: other!.id, number: 1 })
        .returning({ id: episodes.id });
      const [otherScene] = await db()
        .insert(scenes)
        .values({ episodeId: otherEp!.id, orderIndex: 0 })
        .returning({ id: scenes.id });
      const [otherShot] = await db()
        .insert(shots)
        .values({ sceneId: otherScene!.id, orderIndex: 0 })
        .returning({ id: shots.id });

      const asset = await upsertAsset({
        shotId: otherShot!.id,
        episodeId: otherEp!.id,
        kind: 'video',
        provider: 'stub',
        attempt: 0,
        version: 1,
      });

      expect(await claimVideoSlot(other!.id, asset.id)).toBe(true);
    });

    it('ignores a slot whose worker died, once the lease has expired', async () => {
      const shotIds = await db()
        .select({ id: shots.id })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));

      const assetIds: string[] = [];
      for (const shot of shotIds.slice(0, MAX_INFLIGHT_VIDEO_JOBS + 1)) {
        const asset = await upsertAsset({
          shotId: shot.id,
          episodeId,
          kind: 'video',
          provider: 'stub',
          attempt: 0,
          version: 1,
        });
        assetIds.push(asset.id);
        await claimVideoSlot(seriesId, asset.id);
      }

      // Three deaths would otherwise wedge the project permanently, so a claim
      // older than the lease no longer counts against the cap.
      await db().execute(sql`
        update assets set updated_at = now() - interval '30 minutes'
         where status = 'generating' and episode_id = ${episodeId}::uuid
      `);

      expect(await claimVideoSlot(seriesId, assetIds[MAX_INFLIGHT_VIDEO_JOBS]!)).toBe(true);
    });
  });

  /* -- AC #4 and versioning ---------------------------------------------- */

  describe('versions and pruning', () => {
    /** Writes a finished take, as the job would. */
    async function landTake(version: number): Promise<string> {
      const asset = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 0,
        version,
      });
      await db()
        .update(assets)
        .set({
          status: 'ready',
          storagePath: `clips/${userId}/${episodeId}/shots/${shotId}/v${version}/a0.mp4`,
        })
        .where(eq(assets.id, asset.id));
      await db().update(shots).set({ version }).where(eq(shots.id, shotId));
      return asset.id;
    }

    it('keeps takes side by side rather than overwriting', async () => {
      await landTake(1);
      await landTake(2);

      const history = await loadShotVersions(shotId);

      expect(history.map((a) => a.version)).toEqual([2, 1]);
      // Distinct rows and distinct objects — a regeneration that overwrote the
      // previous clip would make reverting impossible.
      expect(new Set(history.map((a) => a.storagePath)).size).toBe(2);
    });

    it('a retry stays inside its take instead of consuming a version', async () => {
      const first = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 0,
        version: 1,
      });
      const retry = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 1,
        version: 1,
      });

      expect(retry.id).not.toBe(first.id);
      expect(retry.version).toBe(1);
      expect((await loadShotVersions(shotId)).every((a) => a.version === 1)).toBe(true);
    });

    it(`prunes to the last ${KEEP_SHOT_VERSIONS} takes, storage included`, async () => {
      for (let version = 1; version <= 5; version++) await landTake(version);

      const result = await pruneShotVersions(shotId);

      expect(result.prunedVersions).toEqual([2, 1]);
      expect(result.deletedObjects).toBe(2);

      const surviving = await loadShotVersions(shotId);
      expect(surviving.map((a) => a.version)).toEqual([5, 4, 3]);

      // The objects went too. A row deleted without its object is an invisible
      // bill nobody will ever look for.
      expect(storage.deleted).toHaveLength(2);
      expect(storage.deleted.some((p) => p.includes('/v1/'))).toBe(true);
      expect(storage.deleted.some((p) => p.includes('/v2/'))).toBe(true);
      expect(storage.deleted.some((p) => p.includes('/v3/'))).toBe(false);
    });

    it('does nothing when there is nothing to prune', async () => {
      await landTake(1);
      await landTake(2);

      expect(await pruneShotVersions(shotId)).toEqual({ prunedVersions: [], deletedObjects: 0 });
      expect(storage.deleted).toHaveLength(0);
    });

    it('does not let an old ready take report the new one finished', async () => {
      await landTake(1);

      // Take 2 opens and is still generating.
      const next = await upsertAsset({
        shotId,
        episodeId,
        kind: 'video',
        provider: 'stub',
        attempt: 0,
        version: 2,
      });
      await db().update(assets).set({ status: 'generating' }).where(eq(assets.id, next.id));
      await db().update(shots).set({ version: 2 }).where(eq(shots.id, shotId));

      // Reconciling must look only at the current take, or version 1's finished
      // clip flips the shot to `ready` while version 2 is still running.
      expect(await reconcileShotStatus(shotId)).toBe('generating');
    });

    it('reports the shot ready once the current take lands', async () => {
      await landTake(1);
      expect(await reconcileShotStatus(shotId)).toBe('ready');
    });
  });
});

describe.skipIf(hasDatabase)('generation pipeline suite', () => {
  it('is skipped without DATABASE_URL', () => {
    console.warn('Skipped: set DATABASE_URL and run `pnpm db:migrate` to execute these.');
    expect(hasDatabase).toBe(false);
  });
});
