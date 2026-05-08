// NOTE: TDD tests written before implementation.
// The inviteDiff function does not yet exist. Tests will fail with
// "cannot find module" or similar until Phase 5 implementation.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { inviteDiff } from '~/services/inviteDiff.js';

describe('inviteDiff', () => {
  it('before empty, after [{code:A, uses:1}] → None (lazy seed semantics — no winner without baseline)', () => {
    const before = new Map<string, number>();
    const after = [{ code: 'A', uses: 1 }];
    expect(inviteDiff(before, after)).toEqual(Option.none());
  });

  it('before Map{A:1}, after [{A:2}] → Some(A)', () => {
    const before = new Map([['A', 1]]);
    const after = [{ code: 'A', uses: 2 }];
    expect(inviteDiff(before, after)).toEqual(Option.some('A'));
  });

  it('before Map{A:1}, after [{A:1}] → None (no change)', () => {
    const before = new Map([['A', 1]]);
    const after = [{ code: 'A', uses: 1 }];
    expect(inviteDiff(before, after)).toEqual(Option.none());
  });

  it('before Map{A:1}, after [{A:2},{B:1}] → Some(A) (B was created earlier but not seen; A has the delta)', () => {
    const before = new Map([['A', 1]]);
    const after = [
      { code: 'A', uses: 2 },
      { code: 'B', uses: 1 },
    ];
    expect(inviteDiff(before, after)).toEqual(Option.some('A'));
  });

  it('before Map{A:1, B:0}, after [{A:2},{B:1}] → None (>1 candidates — ambiguous)', () => {
    const before = new Map([
      ['A', 1],
      ['B', 0],
    ]);
    const after = [
      { code: 'A', uses: 2 },
      { code: 'B', uses: 1 },
    ];
    expect(inviteDiff(before, after)).toEqual(Option.none());
  });

  it('before Map{A:5}, after [] → None (invite deleted → likely vanity, no match)', () => {
    const before = new Map([['A', 5]]);
    const after: Array<{ code: string; uses: number }> = [];
    expect(inviteDiff(before, after)).toEqual(Option.none());
  });

  it('before Map{A:1}, after [{A:0}] → None (uses cannot decrease meaningfully; defensive)', () => {
    const before = new Map([['A', 1]]);
    const after = [{ code: 'A', uses: 0 }];
    expect(inviteDiff(before, after)).toEqual(Option.none());
  });
});
