import 'server-only';

import { z } from 'zod';
import type { LlmProvider } from '@/lib/providers';
import { streamJson } from './json';
import { inputBlock, JSON_RULES } from './prompts/rules';

/**
 * The copy that goes in the post, generated from the episode's own synopsis and
 * cliffhanger. One call, no streaming — it is three short strings and the user
 * is waiting to paste it.
 */

export const exportCopySchema = z.object({
  /** The caption. Hook first, because the feed truncates. */
  caption: z.string().min(1).max(500),
  hashtags: z.array(z.string().min(2).max(40)).min(3).max(12),
  /** Alternative openings, so the user is not stuck with one take. */
  alternates: z.array(z.string().min(1).max(300)).max(3).default([]),
});

export type ExportCopy = z.infer<typeof exportCopySchema>;

const SYSTEM = `You write the caption that ships with a vertical short-drama episode on
TikTok, Reels and YouTube Shorts.

WHAT WORKS:
- The first six words decide whether anyone reads the rest. Open on the hook or the
  question, never on setup.
- Write as if the viewer has already watched it and is deciding whether to comment.
  Ask the question the episode leaves open.
- One or two short sentences. No emoji walls. At most one emoji, and only if it
  earns its place.
- Never say "in this episode", never summarise the plot, never spoil the reversal.

HASHTAGS:
- 5-8 of them. A mix: two broad (#shortdrama, #shortfilm), two about the specific
  hook or genre, one or two about the emotion.
- Lowercase, no spaces, no punctuation beyond the leading #.

${JSON_RULES}

Schema:
{
  "caption": string,        // the caption, under 300 characters
  "hashtags": string[],     // 5-8, each starting with #
  "alternates": string[]    // up to 3 alternative opening lines
}`;

export interface GenerateExportCopyOptions {
  provider: LlmProvider;
  seriesTitle: string;
  episodeNumber: number;
  episodeTitle: string;
  synopsis: string;
  cliffhanger?: string | null;
  language: string;
}

export async function generateExportCopy(options: GenerateExportCopyOptions) {
  const prompt = `Write the caption for episode ${options.episodeNumber} of "${options.seriesTitle}".

${inputBlock({
  seriesTitle: options.seriesTitle,
  episodeNumber: options.episodeNumber,
  episodeTitle: options.episodeTitle,
  synopsis: options.synopsis,
  cliffhanger: options.cliffhanger ?? null,
  language: options.language,
})}

EPISODE: ${options.episodeTitle}
SYNOPSIS: ${options.synopsis}
${options.cliffhanger ? `IT ENDS ON: "${options.cliffhanger}"` : ''}

Write in ${options.language}. Do not spoil how it resolves — the point is to make
someone watch the next one.`;

  return streamJson<ExportCopy>({
    provider: options.provider,
    operation: 'export.caption',
    system: SYSTEM,
    prompt,
    schema: exportCopySchema,
    maxTokens: 8_000,
    effort: 'low',
  });
}
