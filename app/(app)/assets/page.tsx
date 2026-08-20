import { asc, eq } from 'drizzle-orm';
import { requireUser } from '@/lib/auth';
import { withUserDb } from '@/lib/db';
import { characters, episodes, scenes, series, shots } from '@/lib/db/schema';
import { loadAssetLibrary } from '@/lib/data/assets';
import { AssetGrid } from '@/components/assets/asset-grid';

export const metadata = { title: 'Assets · Short Drama Studio' };
export const dynamic = 'force-dynamic';

/**
 * Everything generated, in one place, reusable.
 *
 * The Library next door answers "what have I finished". This answers "what have
 * I made" — every clip, keyframe, still and cut — and lets a picture that
 * already exists be used again instead of paid for twice.
 */
export default async function AssetsPage() {
  const user = await requireUser();
  const library = await loadAssetLibrary(user.id);
  const targets = await loadReuseTargets(user.id);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Assets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {library.items.length === 0
            ? 'Every clip, keyframe, character still and finished cut will appear here.'
            : `${library.items.length} assets · ${formatBytes(library.totalBytes)} · ` +
              `$${(library.totalCostCents / 100).toFixed(2)} of generation`}
        </p>
      </div>

      <AssetGrid
        items={library.items}
        kinds={library.kinds}
        seriesOptions={library.seriesOptions}
        targets={targets}
      />
    </div>
  );
}

/**
 * Where an asset can go.
 *
 * Every character and shot the user owns, across every series — the point of
 * the feature being that a face drawn for one show can hold a scene in
 * another.
 */
async function loadReuseTargets(userId: string) {
  return withUserDb(userId, async (tx) => {
    const characterRows = await tx
      .select({ id: characters.id, name: characters.name, seriesTitle: series.title })
      .from(characters)
      .innerJoin(series, eq(series.id, characters.seriesId))
      .orderBy(asc(series.title), asc(characters.name));

    const shotRows = await tx
      .select({
        id: shots.id,
        orderIndex: shots.orderIndex,
        sceneOrder: scenes.orderIndex,
        episodeNumber: episodes.number,
        seriesTitle: series.title,
      })
      .from(shots)
      .innerJoin(scenes, eq(scenes.id, shots.sceneId))
      .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .orderBy(asc(series.title), asc(episodes.number), asc(scenes.orderIndex), asc(shots.orderIndex));

    return {
      characters: characterRows,
      shots: shotRows.map((row) => ({
        id: row.id,
        label: `${row.seriesTitle} E${row.episodeNumber} · sc ${row.sceneOrder + 1} · sh ${
          row.orderIndex + 1
        }`,
      })),
    };
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 MB';
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}
