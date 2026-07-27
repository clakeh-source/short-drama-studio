import { describe, expect, it } from 'vitest';
import { screenContent, screenWithRules } from '@/lib/ai/safety';
import { getLlmProvider } from '@/lib/providers';

/**
 * Cross-cutting requirement: the safety gate rejects real named public figures,
 * sexual content involving minors or ambiguously-aged characters, and content
 * depicting real identifiable people — and fails closed.
 */

describe('deterministic safety rules', () => {
  it('allows ordinary dark drama between adults', () => {
    expect(
      screenWithRules('A hotel night manager blackmails the heir who faked his own death.'),
    ).toEqual([]);
    expect(screenWithRules('Two rival surgeons destroy each other over a stolen patent.')).toEqual(
      [],
    );
    // Violence and crime are in bounds — this is drama.
    expect(screenWithRules('She kills the man who ruined her mother and hides the body.')).toEqual(
      [],
    );
  });

  it('rejects sexualised minors', () => {
    const findings = screenWithRules('A seductive romance between a teacher and a teenage student.');
    expect(findings.map((f) => f.code)).toContain('minor_sexualisation');
  });

  it('rejects an age-ambiguous sexual framing', () => {
    const findings = screenWithRules('An erotic story about a schoolgirl and her landlord.');
    expect(findings.map((f) => f.code)).toContain('minor_sexualisation');
  });

  it('does not flag a minor in a non-sexual role', () => {
    expect(screenWithRules('A single mother hides her child from a debt collector.')).toEqual([]);
  });

  it('rejects premises framed around real people', () => {
    expect(screenWithRules('Based on a true story about my ex-boss.').map((f) => f.code)).toContain(
      'real_person',
    );
    expect(screenWithRules('A drama about a real-life heiress.').map((f) => f.code)).toContain(
      'real_person',
    );
  });

  it('rejects real public office-holders as characters', () => {
    const findings = screenWithRules('The President of France has a secret second family.');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.code)).toContain('real_person');
  });

  it('returns an actionable message, not a bare refusal', () => {
    const [finding] = screenWithRules('An erotic romance with a 15-year-old.');
    expect(finding?.message).toMatch(/adult/i);
  });
});

describe('screenContent', () => {
  const provider = getLlmProvider('stub');

  it('short-circuits on a rule hit without calling the model', async () => {
    const result = await screenContent({
      provider,
      text: 'An erotic romance with a teenage student.',
    });
    expect(result.allowed).toBe(false);
    // No model pass ran, so no cost was incurred.
    expect(result.costCents).toBeUndefined();
  });

  it('runs the model pass when the rules find nothing', async () => {
    const result = await screenContent({
      provider,
      text: 'A night manager recognises a guest she buried three months ago.',
    });
    expect(result.allowed).toBe(true);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it('honours a model refusal', async () => {
    const result = await screenContent({ provider, text: 'A tense drama. [[unsafe]]' });
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('fails closed when the classifier itself errors', async () => {
    const result = await screenContent({
      provider,
      text: 'An ordinary premise. [[stub:fail-permanent]]',
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/could not complete/i);
  });

  it('can skip the model pass entirely', async () => {
    const result = await screenContent({
      provider,
      text: 'A perfectly ordinary premise.',
      rulesOnly: true,
    });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });
});
