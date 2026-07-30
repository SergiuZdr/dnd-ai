// Pure formatter tests for the dice card's row content -- no ink rendering
// involved, just pinning the exact strings/colors so the numbers are always
// on their own row, never appended after a (possibly long) reason.

import { describe, it, expect } from 'vitest';
import { needLine, revealLine, compactSummary } from '../../src/ui/DiceLine';
import type { RollRevealResult } from '../../src/game/controller';
import type { PendingRollRequest } from '../../src/game/controller';

const LONG_REASON =
  'Persuasion check to convince Constable Voss that ignoring the mill problem endangers the village and that he should help rather than turn a blind eye';

function makeReveal(overrides: Partial<RollRevealResult> = {}): RollRevealResult {
  return {
    message: 'ignored in these tests -- row content never derives from this',
    expr: 'd20',
    reason: 'Persuasion',
    first: { text: '[7]', total: 7 },
    keptTotal: 7,
    canReroll: false,
    luck: 1,
    ...overrides,
  };
}

describe('needLine (waiting row2)', () => {
  it('states the target number and expression when dc is known', () => {
    expect(needLine({ expr: 'd20+3', reason: 'x', dc: 13 })).toBe('Need 13+ on d20+3 to succeed');
  });

  it('falls back to a plain "Roll <expr>" when there is no dc', () => {
    expect(needLine({ expr: 'd20+3', reason: 'x' })).toBe('Roll d20+3');
  });

  it('never includes the reason -- it cannot be pushed off by a long one', () => {
    const request: PendingRollRequest = { expr: 'd20', reason: LONG_REASON, dc: 13 };
    expect(needLine(request)).not.toContain('Persuasion');
    expect(needLine(request)).toBe('Need 13+ on d20 to succeed');
  });
});

describe('revealLine (revealed row2) -- the row this whole fix exists to protect', () => {
  it('shows the roll detail and total with no dc', () => {
    const { text, color } = revealLine(makeReveal({ dc: undefined, success: undefined }));
    expect(text).toBe('Rolled [7] = 7');
    expect(color).toBeUndefined();
  });

  it('shows "needed N+" and a green ✓ SUCCESS verdict on a pass', () => {
    const { text, color } = revealLine(makeReveal({ dc: 13, success: true, keptTotal: 14, first: { text: '[11]+3', total: 14 } }));
    expect(text).toBe('Rolled [11]+3 = 14 — needed 13+ → ✓ SUCCESS');
    expect(color).toBe('green');
  });

  it('shows a red ✗ FAILURE verdict on a fail', () => {
    const { text, color } = revealLine(makeReveal({ dc: 13, success: false, keptTotal: 7 }));
    expect(text).toBe('Rolled [7] = 7 — needed 13+ → ✗ FAILURE');
    expect(color).toBe('red');
  });

  it('shows both totals in plain numbers (no per-die detail) after a luck reroll', () => {
    const { text } = revealLine(
      makeReveal({
        first: { text: '[7]', total: 7 },
        reroll: { text: '[16]', total: 16 },
        keptTotal: 16,
        dc: 13,
        success: true,
      }),
    );
    expect(text).toBe('Rolled 7, luck reroll 16 — needed 13+ → ✓ SUCCESS');
  });

  it('never includes the reason, no matter how long -- the numbers can never be truncated away by it', () => {
    const { text } = revealLine(makeReveal({ reason: LONG_REASON, dc: 13, success: false, keptTotal: 7 }));
    expect(text).not.toContain('Constable');
    expect(text).toBe('Rolled [7] = 7 — needed 13+ → ✗ FAILURE');
  });
});

describe('compactSummary (idle row1 after a player roll)', () => {
  it('shows the reason, total, dc, and a ✗/✓ symbol when dc is known', () => {
    expect(compactSummary(makeReveal({ dc: 13, success: false, keptTotal: 7 }))).toBe('🎲 Persuasion — 7 vs 13 ✗');
    expect(compactSummary(makeReveal({ dc: 13, success: true, keptTotal: 14 }))).toBe('🎲 Persuasion — 14 vs 13 ✓');
  });

  it('omits the vs/symbol entirely when there is no dc', () => {
    expect(compactSummary(makeReveal({ dc: undefined, success: undefined, keptTotal: 9 }))).toBe('🎲 Persuasion — 9');
  });

  it('reflects the kept (post-reroll) total, not the first roll', () => {
    const reveal = makeReveal({
      first: { text: '[7]', total: 7 },
      reroll: { text: '[16]', total: 16 },
      keptTotal: 16,
      dc: 13,
      success: true,
    });
    expect(compactSummary(reveal)).toBe('🎲 Persuasion — 16 vs 13 ✓');
  });

  it('reproduces the exact reported bug scenario correctly once the reason is realistically short (the schema/prompt fix)', () => {
    // Before this fix: a sentence-length reason pushed "7 vs 13 ✗" off the
    // end of a single truncated line. With the reason isolated to its own
    // row1 (bold, "🎲 ROLL — <reason>") and the numbers composed on their
    // own row from structured fields, the outcome is always visible
    // regardless of reason length -- but tools.ts/prompts.ts now also ask
    // the DM for a short label in the first place. Confirm a realistic short
    // reason renders exactly as intended:
    const reveal = makeReveal({ reason: 'Persuasion — sway the constable', dc: 13, success: false, keptTotal: 7 });
    expect(compactSummary(reveal)).toBe('🎲 Persuasion — sway the constable — 7 vs 13 ✗');
    expect(revealLine(reveal).text).toBe('Rolled [7] = 7 — needed 13+ → ✗ FAILURE');
  });
});
