/**
 * The choices that shape a series, shared by both ways of starting one.
 *
 * Extracted when the import flow arrived: it asks the same questions as the
 * generate flow minus the premise, and two divergent copies of these lists
 * would show a user different genres depending on which button they pressed.
 */

export const GENRES = [
  'Revenge',
  'Secret identity',
  'Billionaire romance',
  'Family betrayal',
  'Workplace thriller',
  'Supernatural',
  'Crime',
  'Medical',
] as const;

export const TONES = [
  'Cold and controlled',
  'Melodramatic',
  'Darkly funny',
  'Tense',
  'Tender',
] as const;

export const AUDIENCES = ['Adults 18-34', 'Adults 25-44', 'Adults 35+', 'General adult'] as const;

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
] as const;
