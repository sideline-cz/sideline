import { BankTransaction } from '@sideline/domain';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const suffix = params ? ` ${JSON.stringify(params)}` : '';
    return `${key}${suffix}`;
  },
}));

const { matchReasonLabels, matchReasonIcons, matchReasonDashed, matchReasonHint, duplicateHint } =
  await import('./matchReasons.js');

const REASONS = BankTransaction.BankTransactionMatchReason.literals;

describe('matchReasonLabels / matchReasonIcons / matchReasonDashed — closed Record coverage', () => {
  it('has exactly the nine reasons from the domain union, no more, no fewer', () => {
    expect(new Set(Object.keys(matchReasonLabels))).toEqual(new Set(REASONS));
    expect(Object.keys(matchReasonLabels)).toHaveLength(9);
  });

  it('every reason has a distinct icon', () => {
    const icons = Object.values(matchReasonIcons);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('dashed is true for exactly the four ambiguous reasons', () => {
    const dashedReasons = Object.entries(matchReasonDashed)
      .filter(([, dashed]) => dashed)
      .map(([reason]) => reason)
      .sort();
    expect(dashedReasons).toEqual(
      [
        'ambiguous_member',
        'ambiguous_multiple_exact',
        'ambiguous_multiple_open',
        'no_open_assignment',
      ].sort(),
    );
  });

  it('every label call renders through tr(), never a raw key', () => {
    for (const reason of REASONS) {
      const label = matchReasonLabels[reason]();
      expect(label.startsWith('bank_reason_')).toBe(true);
    }
  });

  it('does not contain possible_duplicate — it is a hint, never a match_reason', () => {
    expect(Object.keys(matchReasonLabels)).not.toContain('possible_duplicate');
  });
});

describe('matchReasonHint', () => {
  it('no_vs with a resolved member renders the guess hint', () => {
    const hint = matchReasonHint({
      matchReason: 'no_vs',
      matchedMemberName: 'Jan Novák',
      variableSymbol: null,
      duplicateOfTransactionId: null,
    });
    expect(hint).toContain('bank_reason_noVsHintGuess');
  });

  it('no_vs with no resolved member renders the "nobody recognised" hint', () => {
    const hint = matchReasonHint({
      matchReason: 'no_vs',
      matchedMemberName: null,
      variableSymbol: null,
      duplicateOfTransactionId: null,
    });
    expect(hint).toContain('bank_reason_noVsHintNone');
  });

  it('returns undefined when matchReason is null', () => {
    expect(
      matchReasonHint({
        matchReason: null,
        matchedMemberName: null,
        variableSymbol: null,
        duplicateOfTransactionId: null,
      }),
    ).toBeUndefined();
  });
});

describe('duplicateHint', () => {
  it('renders when a duplicate is present', () => {
    const hint = duplicateHint({
      matchReason: 'no_open_assignment',
      matchedMemberName: 'Jan Novák',
      variableSymbol: '2026014',
      duplicateOfTransactionId: 'tx-1',
      duplicateOfDate: '1. 3. 2026',
    });
    expect(hint).toContain('bank_reason_duplicateHint');
  });

  it('returns undefined when there is no duplicate', () => {
    expect(
      duplicateHint({
        matchReason: 'no_open_assignment',
        matchedMemberName: null,
        variableSymbol: null,
        duplicateOfTransactionId: null,
      }),
    ).toBeUndefined();
  });
});
