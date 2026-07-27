import { dynamicRoute } from '@/lib/api/handler';
import { loadStoryboard } from '@/lib/data/storyboard';
import { estimateEpisodeCost } from '@/lib/data/estimate';
import { getTtsProvider, getVideoProvider } from '@/lib/providers';

/** What generating this episode's assets would cost, before anything is spent. */
export const GET = dynamicRoute<{ id: string }>(
  { operation: 'episode.estimate' },
  async ({ params, user }) => {
    const board = await loadStoryboard(user.id, params.id);
    const allShots = board.scenes.flatMap((s) => s.shots);

    return estimateEpisodeCost(allShots, getVideoProvider(), getTtsProvider());
  },
);
