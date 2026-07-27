import 'server-only';

import type { LlmProvider } from '@/lib/providers';
import { log } from '@/lib/log';
import { streamJson } from './json';
import { safetyVerdictSchema, type SafetyVerdict } from './schemas';
import { inputBlock, JSON_RULES } from './prompts/rules';

/**
 * Content safety gate. Runs before any generation call and **fails closed** —
 * if the classifier itself errors, the request is refused, not waved through.
 *
 * Two layers:
 *  1. Deterministic rules, so the obvious cases are caught for free and are
 *     unit-testable without a model.
 *  2. A model pass for everything the rules cannot see.
 */

/* -------------------------------------------------------------------------- */
/* Layer 1 — deterministic rules                                              */
/* -------------------------------------------------------------------------- */

/** Wording that puts a sexual or romantic frame on an under-age subject. */
const MINOR_TERMS =
  /\b(child|children|kid|kids|minor|minors|teen|teens|teenage|teenager|underage|schoolgirl|schoolboy|preteen|toddler|infant|baby|babies|\d{1,2}[- ]year[- ]old)\b/i;

const SEXUAL_TERMS =
  /\b(sex|sexual|sexually|erotic|erotica|nude|nudity|naked|seduce|seduction|seductive|lust|lingerie|strip|stripping|intimate|intimacy|aroused|arousal|fetish|porn|pornographic)\b/i;

/** Framings that assert a real, identifiable person is the subject. */
const REAL_PERSON_MARKERS =
  /\b(real[- ]life|actual|based on (?:a )?(?:real|true)|true story|real person|my (?:ex|boss|neighbou?r|coworker|colleague|teacher|landlord)|the president|the prime minister|the pope|the ceo of)\b/i;

/** Roles that only exist as real, identifiable public offices. */
const PUBLIC_FIGURE_ROLES =
  /\b(president|prime minister|senator|congressman|congresswoman|monarch|the king of|the queen of|pope|chancellor|governor of|mayor of)\s+(?:of\s+)?[A-Z][a-z]+/;

export interface RuleFinding {
  code: 'minor_sexualisation' | 'real_person' | 'public_figure';
  message: string;
}

/**
 * Pure — no model, no network. Exported so the rules can be tested directly and
 * reused by Phase 3 before every paid generation call.
 */
export function screenWithRules(text: string): RuleFinding[] {
  const findings: RuleFinding[] = [];

  if (MINOR_TERMS.test(text) && SEXUAL_TERMS.test(text)) {
    findings.push({
      code: 'minor_sexualisation',
      message:
        'This premise puts a sexual or romantic frame on a character who reads as a minor. ' +
        'Every character has to be an adult, and unambiguously read as one.',
    });
  }

  if (REAL_PERSON_MARKERS.test(text)) {
    findings.push({
      code: 'real_person',
      message:
        'This premise is framed around a real, identifiable person. Rewrite it around ' +
        'invented characters — the generated footage would otherwise depict someone real.',
    });
  }

  if (PUBLIC_FIGURE_ROLES.test(text)) {
    findings.push({
      code: 'public_figure',
      message:
        'This premise casts a real public office-holder as a character. Use a fictional ' +
        'equivalent instead.',
    });
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Layer 2 — model pass                                                       */
/* -------------------------------------------------------------------------- */

const SYSTEM = `You screen premises for a short-drama generator that turns text into
photorealistic video of people. Because the output is photorealistic footage, the bar
is higher than for prose.

Refuse (allowed: false) if the text:
- names or unmistakably identifies a real person, living or dead, as a character;
- casts a real public figure or office-holder;
- depicts a real, identifiable private individual;
- sexualises a minor, or any character whose age is left ambiguous;
- requires generating a real person's likeness.

Allow (allowed: true) everything else, including dark, violent, criminal or morally
ugly fiction. This is drama. Melodrama, revenge, infidelity, crime and cruelty between
consenting adult fictional characters are all in bounds.

When you refuse, each reason is one sentence addressed to the writer, explaining what
to change. Do not lecture.

${JSON_RULES}

Schema: { "allowed": boolean, "reasons": string[] }`;

export interface ScreenResult {
  allowed: boolean;
  reasons: string[];
  /** Present when the model pass ran; absent when rules alone decided. */
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ScreenOptions {
  provider: LlmProvider;
  text: string;
  /** Skip the model pass — for high-volume internal checks. */
  rulesOnly?: boolean;
}

export async function screenContent(options: ScreenOptions): Promise<ScreenResult> {
  const findings = screenWithRules(options.text);
  if (findings.length > 0) {
    return { allowed: false, reasons: findings.map((f) => f.message) };
  }

  if (options.rulesOnly) {
    return { allowed: true, reasons: [] };
  }

  try {
    const result = await streamJson<SafetyVerdict>({
      provider: options.provider,
      operation: 'safety.screen',
      system: SYSTEM,
      prompt: `Screen this text.\n\n${inputBlock({ text: options.text })}`,
      schema: safetyVerdictSchema,
      maxTokens: 2_000,
      effort: 'low',
    });

    return {
      allowed: result.data.allowed,
      reasons: result.data.reasons,
      costCents: result.usage.costCents,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    };
  } catch (error) {
    // Fail closed. A classifier that cannot run is not a pass.
    log.error('safety screen failed closed', {
      operation: 'safety.screen',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      allowed: false,
      reasons: [
        'The content check could not complete, so the request was refused. Try again in a moment.',
      ],
    };
  }
}
