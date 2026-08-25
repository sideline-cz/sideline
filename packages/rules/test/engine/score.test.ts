/**
 * `score` / `answeredCount` count only in-pool answers (a scenario whose
 * level was deselected mid-run must not count either way). `scoreAttempt` is
 * the honour-system scoring primitive (Phase 0 plan, decision D5's
 * corollary) — shared logic, not a trust boundary, but it must still be
 * order-independent and defend itself against a client sending garbage
 * picks rather than indexing blindly into `opts`.
 */
import { describe, expect, it } from 'vitest';
import type { Step } from '~/types.js';
import { answer, loc, runState, scenario, sid, step, stepPick } from './helpers.js';

const { answeredCount, score, scoreAttempt } = await import('~/engine/score.js');

describe('score / answeredCount', () => {
  const inLevel1 = scenario({ id: sid('a'), level: 1 });
  const alsoLevel1 = scenario({ id: sid('b'), level: 1 });
  const level2 = scenario({ id: sid('c'), level: 2 });
  const scenarios = [inLevel1, alsoLevel1, level2];

  it('score counts only done+ok answers within the current pool (sel)', () => {
    const state = runState({
      sel: [1],
      answers: {
        [inLevel1.id]: answer({ steps: [stepPick(0, true)], done: true, ok: true }),
        [alsoLevel1.id]: answer({ steps: [stepPick(1, false)], done: true, ok: false }),
        // Correct and done, but level 2 is not in sel — must not count.
        [level2.id]: answer({ steps: [stepPick(0, true)], done: true, ok: true }),
      },
    });
    expect(score(state, scenarios)).toBe(1);
  });

  it('answeredCount counts only done answers within the current pool, regardless of ok', () => {
    const state = runState({
      sel: [1],
      answers: {
        [inLevel1.id]: answer({ steps: [stepPick(0, true)], done: true, ok: true }),
        [alsoLevel1.id]: answer({ steps: [stepPick(1, false)], done: true, ok: false }),
        [level2.id]: answer({ steps: [stepPick(0, true)], done: true, ok: true }),
      },
    });
    expect(answeredCount(state, scenarios)).toBe(2);
  });

  it('an in-progress (not done) answer counts toward neither', () => {
    const state = runState({
      sel: [1],
      answers: { [inLevel1.id]: answer({ steps: [stepPick(0, true)], done: false, ok: false }) },
    });
    expect(score(state, scenarios)).toBe(0);
    expect(answeredCount(state, scenarios)).toBe(0);
  });
});

describe('scoreAttempt', () => {
  const okOpt = { t: loc('right'), ok: true as const, why: loc('because') };
  const badOpt = { t: loc('wrong'), why: loc('because') };

  // Step where original index 0 is correct, and a step where original index
  // 1 is correct — distinct enough to catch an index/order mixup.
  const chain: readonly Step[] = [
    step({ opts: [okOpt, badOpt] }),
    step({ opts: [badOpt, okOpt] }),
    step({ opts: [okOpt, badOpt, badOpt] }),
  ];

  it('scores a fully correct attempt as ok', () => {
    const result = scoreAttempt(chain, [0, 1, 0]);
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it('scores a partially wrong attempt as not ok, but records each step correctly', () => {
    const result = scoreAttempt(chain, [1, 1, 0]);
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.ok)).toEqual([false, true, true]);
  });

  it('is order-independent: permuting the chain and the picks together does not change the outcome', () => {
    const picks = [0, 1, 0];
    const straight = scoreAttempt(chain, picks);

    const permutation = [2, 0, 1];
    const permutedChain = permutation.map((i) => chain[i]) as readonly Step[];
    const permutedPicks = permutation.map((i) => picks[i]) as readonly number[];
    const permuted = scoreAttempt(permutedChain, permutedPicks);

    expect(permuted.ok).toBe(straight.ok);
    expect([...permuted.steps.map((s) => s.ok)].sort()).toEqual(
      [...straight.steps.map((s) => s.ok)].sort(),
    );
  });

  it.each([
    -1,
    99,
    1.5,
    Number.NaN,
  ])('rejects an invalid pick (%p) rather than indexing blindly', (badPick) => {
    const result = scoreAttempt(chain, [badPick, 1, 0]);
    expect(result.steps[0]?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(() => scoreAttempt(chain, [badPick, 1, 0])).not.toThrow();
  });

  it('a non-integer pick never gets treated as correct even if it rounds to the right index', () => {
    const result = scoreAttempt(chain, [0.0001, 1, 0]);
    expect(result.steps[0]?.ok).toBe(false);
  });

  describe('hostile input — never throws, never echoes an unserializable value', () => {
    it('does not throw on a null or undefined picks array, and scores nothing as ok', () => {
      expect(() => scoreAttempt(chain, null as unknown as readonly number[])).not.toThrow();
      expect(() => scoreAttempt(chain, undefined as unknown as readonly number[])).not.toThrow();
      const result = scoreAttempt(chain, null as unknown as readonly number[]);
      expect(result.ok).toBe(false);
      expect(result.steps.every((s) => s.pick === null && s.ok === false)).toBe(true);
    });

    it('rejects a too-long picks array rather than tolerating it', () => {
      const result = scoreAttempt(chain, [0, 1, 0, 0, 0, 0]);
      expect(result.ok).toBe(false);
      expect(result.steps.every((s) => s.pick === null)).toBe(true);
    });

    it('rejects a too-short picks array (already correct, pinned so it cannot regress)', () => {
      const result = scoreAttempt(chain, [0]);
      expect(result.ok).toBe(false);
      expect(result.steps.every((s) => s.pick === null)).toBe(true);
    });

    it.each([
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a numeric string', '0'],
      ['an object', {}],
      ['a boolean', true],
      ['a bigint', 1n],
      ['null', null],
      ['undefined', undefined],
    ])('normalises %s to pick: null rather than echoing it back', (_label, badPick) => {
      const picks = [badPick, 1, 0] as unknown as readonly number[];
      expect(() => scoreAttempt(chain, picks)).not.toThrow();
      const result = scoreAttempt(chain, picks);
      expect(result.steps[0]).toEqual({ pick: null, ok: false });
      // The whole `Answer` must still be a valid JSON.stringify round trip —
      // no NaN/Infinity (silently become null, breaking the `pick: number`
      // contract) and, more importantly, no bigint (JSON.stringify throws).
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it('-0 is still treated as the valid index 0 (unchanged behaviour)', () => {
      const result = scoreAttempt(chain, [-0, 1, 0]);
      expect(result.steps[0]).toEqual({ pick: -0, ok: true });
    });
  });
});
