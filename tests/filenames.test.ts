import { describe, expect, it } from 'vitest';
import { episodeFilename } from '@/lib/filenames';

/**
 * These names land on someone's disk from a bulk download, built out of a series
 * title the user typed. A stray slash would create a directory or fail the save
 * outright.
 */
describe('episodeFilename', () => {
  it('builds a sortable, readable name', () => {
    expect(
      episodeFilename({ seriesTitle: 'The Midnight Ledger', number: 3, title: 'Night 3' }),
    ).toBe('The Midnight Ledger - 03 - Night 3.mp4');
  });

  it('zero-pads so a folder sorts in story order', () => {
    const names = [1, 2, 10, 11].map((number) =>
      episodeFilename({ seriesTitle: 'S', number, title: '' }),
    );
    expect(names).toEqual(['S - 01.mp4', 'S - 02.mp4', 'S - 10.mp4', 'S - 11.mp4']);
    expect([...names].sort()).toEqual(names);
  });

  it('strips path separators and characters that are illegal on Windows', () => {
    const name = episodeFilename({
      seriesTitle: 'A/B\\C:D*E?F"G<H>I|J',
      number: 1,
      title: 'x',
    });
    expect(name).toBe('ABCDEFGHIJ - 01 - x.mp4');
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('collapses runs of whitespace rather than leaving gaps', () => {
    expect(episodeFilename({ seriesTitle: '  A   B  ', number: 1, title: '' })).toBe(
      'A B - 01.mp4',
    );
  });

  it('falls back to "Series" when the title reduces to nothing', () => {
    expect(episodeFilename({ seriesTitle: '💀💀💀', number: 4, title: '' })).toBe(
      'Series - 04.mp4',
    );
  });

  it('omits the episode title when there is not one', () => {
    expect(episodeFilename({ seriesTitle: 'S', number: 7, title: '   ' })).toBe('S - 07.mp4');
  });
});
