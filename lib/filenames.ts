/**
 * Download filenames.
 *
 * Kept out of both the client component and the `server-only` data module so it
 * can be imported from either side and tested on its own — a series title is
 * arbitrary user text, and it ends up in a filename on someone's disk.
 */

/**
 * `Series - 03 - Title.mp4`.
 *
 * Strips anything that is not a word character, space, dot or hyphen: `/` and `\`
 * would create directories or break the download outright, and `:` is illegal on
 * Windows and historically meaningful on macOS. The episode number is zero-padded
 * so a directory of exports sorts in story order rather than 1, 10, 11, 2.
 */
export function episodeFilename(input: {
  seriesTitle: string;
  number: number;
  title: string;
}): string {
  const clean = (s: string) =>
    s
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const parts = [
    clean(input.seriesTitle) || 'Series',
    String(input.number).padStart(2, '0'),
    clean(input.title),
  ].filter(Boolean);

  return `${parts.join(' - ')}.mp4`;
}
