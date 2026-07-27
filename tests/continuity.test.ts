import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '@/lib/db';
import { episodes, series } from '@/lib/db/schema';
import { loadContinuitySummary } from '@/lib/data/series';
import {
  composeContinuitySummary,
  CONTINUITY_BUDGET_CHARS,
  type PriorEpisode,
} from '@/lib/ai/continuity';
import { generateScript } from '@/lib/ai/script';
import { getLlmProvider } from '@/lib/providers';
import type { Bible } from '@/lib/ai/schemas';

/**
 * Phase 5 AC #1 — episode 3's script must be written knowing episodes 1 and 2.
 *
 * `generateScript` has accepted a `continuitySummary` since Phase 1, but nothing
 * built one, so the parameter was dead and every episode was written in
 * isolation. These tests assert the *prompt payload*, not the model's output:
 * asserting output would measure the model, whereas the requirement is about
 * what we send it.
 */

function episode(number: number, over: Partial<PriorEpisode> = {}): PriorEpisode {
  return {
    number,
    title: `Night ${number}`,
    synopsis: `Bible plan for episode ${number}.`,
    hook: null,
    cliffhanger: `Cliffhanger of episode ${number}.`,
    script: {
      scenes: [
        { summary: `Episode ${number} scene one: Mara confronts the ledger.` },
        { summary: `Episode ${number} scene two: Dane denies everything.` },
      ],
    },
    ...over,
  };
}

describe('composeContinuitySummary', () => {
  it('is empty for episode 1, so the prompt omits the section entirely', () => {
    expect(composeContinuitySummary([], 1)).toBe('');
    expect(composeContinuitySummary([episode(1)], 1)).toBe('');
  });

  it('AC #1 — writing episode 3 recaps both episode 1 and episode 2', () => {
    const summary = composeContinuitySummary([episode(1), episode(2)], 3);

    expect(summary).not.toBe('');
    expect(summary).toContain('Episode 1');
    expect(summary).toContain('Episode 2');
    expect(summary).toContain('Night 1');
    expect(summary).toContain('Night 2');
  });

  it('never leaks a future episode into the prompt', () => {
    const summary = composeContinuitySummary([episode(1), episode(2), episode(3), episode(4)], 3);

    expect(summary).toContain('Episode 1');
    expect(summary).toContain('Episode 2');
    // Episode 3 is being written; episode 4 has not happened.
    expect(summary).not.toContain('Episode 3');
    expect(summary).not.toContain('Episode 4');
  });

  it('calls the previous cliffhanger out as the thread to pick up', () => {
    const summary = composeContinuitySummary([episode(1), episode(2)], 3);

    expect(summary).toContain('UNRESOLVED');
    expect(summary).toContain('Cliffhanger of episode 2.');
    // The older cliffhanger is history, not the open thread.
    expect(summary).not.toMatch(/UNRESOLVED[^]*Cliffhanger of episode 1/);
  });

  it('prefers what the script actually shows over the bible plan', () => {
    const summary = composeContinuitySummary([episode(1)], 2);

    expect(summary).toContain('Mara confronts the ledger');
    expect(summary).not.toContain('Bible plan for episode 1');
  });

  it('falls back to the synopsis for an episode that has no script yet', () => {
    const summary = composeContinuitySummary([episode(1, { script: null })], 2);
    expect(summary).toContain('Bible plan for episode 1');
  });

  it('ignores an earlier episode that is entirely empty', () => {
    const blank = episode(1, { script: null, synopsis: '   ' });
    expect(composeContinuitySummary([blank], 2)).toBe('');
  });

  it('stays inside its budget for a long series, and keeps its line structure', () => {
    const long = Array.from({ length: 30 }, (_, i) =>
      episode(i + 1, {
        script: { scenes: [{ summary: 'x'.repeat(2_000) }] },
      }),
    );
    const summary = composeContinuitySummary(long, 31);

    expect(summary.length).toBeLessThanOrEqual(CONTINUITY_BUDGET_CHARS);
    // Collapsing the newlines would undo the per-episode formatting.
    expect(summary).toContain('\n');
  });

  it('gives the most recent episodes more room than older ones', () => {
    const body = (n: number) => `episode ${n} ` + 'detail '.repeat(100);
    const eps = [1, 2, 3, 4].map((n) =>
      episode(n, { script: { scenes: [{ summary: body(n) }] } }),
    );
    const summary = composeContinuitySummary(eps, 5);

    const lineFor = (n: number) =>
      summary.split('\n').find((l) => l.startsWith(`- Episode ${n} `)) ?? '';

    expect(lineFor(4).length).toBeGreaterThan(lineFor(1).length);
  });
});

/* -------------------------------------------------------------------------- */
/* The prompt payload itself                                                  */
/* -------------------------------------------------------------------------- */

const bible: Bible = {
  title: 'The Midnight Ledger',
  logline: 'A clerk finds her own death recorded in a ledger.',
  world: 'A private bank that keeps books on the living and the dead.',
  tone_rules: ['Cold and procedural.', 'No supernatural explanation is ever confirmed.'],
  characters: [
    {
      name: 'Mara Vance',
      role: 'protagonist',
      description: 'A night clerk.',
      appearance_prompt: 'a woman in her late twenties, dark hair, charcoal blazer, tired eyes',
    },
    {
      name: 'Dane Ashford',
      role: 'antagonist',
      description: 'The bank manager.',
      appearance_prompt: 'a man in his fifties, silver hair, three-piece grey suit, gold signet',
    },
    {
      name: 'Iris Calloway',
      role: 'ally',
      description: 'An auditor.',
      appearance_prompt: 'a woman in her forties, close-cropped hair, navy raincoat, wire glasses',
    },
  ],
  season_arc: 'Mara traces the ledger to its author.',
  episodes: [
    { number: 1, title: 'Night 1', synopsis: 'Mara finds the entry.' },
    { number: 2, title: 'Night 2', synopsis: 'Dane covers it up.' },
    { number: 3, title: 'Night 3', synopsis: 'Iris arrives with the audit.' },
  ],
};

describe('AC #1 — the summary reaches the prompt payload', () => {
  it('embeds a non-empty continuity summary when writing episode 3', async () => {
    const continuitySummary = composeContinuitySummary([episode(1), episode(2)], 3);
    expect(continuitySummary.length).toBeGreaterThan(0);

    const result = await generateScript({
      provider: getLlmProvider('stub'),
      bible,
      episodeNumber: 3,
      episodeSeconds: 60,
      language: 'en',
      continuitySummary,
    });

    expect(result.continuitySummary).toBe(continuitySummary);
    expect(result.prompt).toContain('WHAT HAS HAPPENED SO FAR');
    expect(result.prompt).toContain(continuitySummary);
    expect(result.prompt).toContain('Episode 1');
    expect(result.prompt).toContain('Episode 2');
    expect(result.prompt).toContain('UNRESOLVED');
  });

  it('omits the section for episode 1 rather than sending an empty heading', async () => {
    const result = await generateScript({
      provider: getLlmProvider('stub'),
      bible,
      episodeNumber: 1,
      episodeSeconds: 60,
      language: 'en',
    });

    expect(result.continuitySummary).toBe('');
    expect(result.prompt).not.toContain('WHAT HAS HAPPENED SO FAR');
  });
});

/* -------------------------------------------------------------------------- */
/* The loader's SQL filter                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `loadContinuitySummary` restates the "earlier episodes only" rule as a SQL
 * `lt()`, so the composer's own tests cannot catch a wrong filter here. A leak
 * would spoil the ending of a series in the prompt for episode 2.
 */
describe.skipIf(!process.env.DATABASE_URL).sequential('loadContinuitySummary', () => {
  const userId = crypto.randomUUID();
  let seriesId: string;

  beforeAll(async () => {
    const handle = db();
    const [s] = await handle
      .insert(series)
      .values({
        userId,
        title: 'Continuity fixture',
        logline: 'A test series.',
        episodeTargetCount: 4,
        episodeTargetSeconds: 60,
      })
      .returning();
    seriesId = s!.id;

    await handle.insert(episodes).values(
      [1, 2, 3, 4].map((n) => ({
        seriesId,
        number: n,
        title: `Night ${n}`,
        synopsis: `Plan for ${n}.`,
        cliffhanger: `Cliff ${n}.`,
        script: { scenes: [{ summary: `Episode ${n} happened.` }] },
        status: 'scripted' as const,
      })),
    );
  });

  afterAll(async () => {
    await db().delete(series).where(eq(series.userId, userId));
    await closeDb();
  });

  it('returns only the episodes before the one being written', async () => {
    const summary = await loadContinuitySummary(userId, seriesId, 3);

    expect(summary).toContain('Episode 1 happened.');
    expect(summary).toContain('Episode 2 happened.');
    expect(summary).not.toContain('Episode 3 happened.');
    expect(summary).not.toContain('Episode 4 happened.');
    expect(summary).toContain('Cliff 2.');
  });

  it('is empty for the first episode', async () => {
    expect(await loadContinuitySummary(userId, seriesId, 1)).toBe('');
  });
});
