/**
 * `buildPerms` / `shuffle` — correct options are authored first, so practice
 * must shuffle display order or every answer would be "A" (Phase 0 plan,
 * decision D4/D5). `buildPerms` now runs eagerly once per run rather than
 * lazily memoizing into state on first read.
 */
import { describe, expect, it } from 'vitest';
import { makeRng, scenario, sid, step } from './helpers.js';

const { buildPerms, buildRunPerms, shuffle } = await import('~/engine/perms.js');

describe('buildPerms', () => {
  it('yields exactly one permutation per step of the chain', () => {
    const sc = scenario({
      steps: [
        step({
          opts: [
            { t: { en: 'a', cs: 'a' }, ok: true, why: { en: '', cs: '' } },
            { t: { en: 'b', cs: 'b' }, why: { en: '', cs: '' } },
          ],
        }),
        step({
          opts: [
            { t: { en: 'a', cs: 'a' }, why: { en: '', cs: '' } },
            { t: { en: 'b', cs: 'b' }, ok: true, why: { en: '', cs: '' } },
            { t: { en: 'c', cs: 'c' }, why: { en: '', cs: '' } },
          ],
        }),
      ],
    });
    const perms = buildPerms(sc, makeRng(7));
    expect(perms).toHaveLength(sc.steps.length);
    perms.forEach((perm, i) => {
      expect([...perm].sort((a, b) => a - b)).toEqual(sc.steps[i]?.opts.map((_, j) => j));
    });
  });

  it('each permutation is a genuine permutation, not a copy of the identity order every time', () => {
    // Over many steps with several options, at least one must differ from
    // identity order, or the shuffle isn't doing anything.
    const manyOptStep = step({
      opts: Array.from({ length: 8 }, (_, j) => ({
        t: { en: `o${j}`, cs: `o${j}` },
        why: { en: '', cs: '' },
        ...(j === 0 ? { ok: true as const } : {}),
      })),
    });
    const sc = scenario({ steps: [manyOptStep] });
    const perms = buildPerms(sc, makeRng(123));
    const identity = manyOptStep.opts.map((_, j) => j);
    expect(perms[0]).not.toEqual(identity);
  });
});

describe('buildRunPerms', () => {
  it('populates one buildPerms result per scenario currently in the pool, and nothing outside it', () => {
    const inPool = scenario({
      id: sid('in'),
      level: 1,
      steps: [step(), step()],
    });
    const outOfPool = scenario({ id: sid('out'), level: 2, steps: [step()] });
    const scenarios = [inPool, outOfPool];

    const perms = buildRunPerms(scenarios, [1], makeRng(1));

    expect(Object.keys(perms)).toEqual([inPool.id]);
    const stepPerms = perms[inPool.id];
    expect(stepPerms).toHaveLength(inPool.steps.length);
    stepPerms?.forEach((perm, i) => {
      expect([...perm].sort((a, b) => a - b)).toEqual(inPool.steps[i]?.opts.map((_, j) => j));
    });
  });

  it('is deterministic under an injected stub rng', () => {
    const scenarios = [
      scenario({ id: sid('a'), level: 1, steps: [step(), step()] }),
      scenario({ id: sid('b'), level: 1, steps: [step()] }),
    ];
    const first = buildRunPerms(scenarios, [1], makeRng(9));
    const second = buildRunPerms(scenarios, [1], makeRng(9));
    expect(second).toEqual(first);
  });
});

describe('shuffle', () => {
  it('does not mutate its input array', () => {
    const input = [1, 2, 3, 4, 5];
    const original = [...input];
    shuffle(input, makeRng(1));
    expect(input).toEqual(original);
  });

  it('returns an array with the same multiset of elements', () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffle(input, makeRng(2));
    expect([...result].sort((a, b) => a - b)).toEqual(input);
  });

  it('is deterministic for a given rng', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(input, makeRng(99));
    const b = shuffle(input, makeRng(99));
    expect(a).toEqual(b);
  });

  it('produces a different order than the input for a long enough array (sanity, not identity)', () => {
    const input = Array.from({ length: 10 }, (_, i) => i);
    const result = shuffle(input, makeRng(5));
    expect(result).not.toEqual(input);
  });
});
