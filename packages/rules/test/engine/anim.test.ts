/**
 * The spoiler gate, half A: `animLimit` decides how far the demo is allowed
 * to play — reveal the resolution too early and a step's later options give
 * away the previous step's answer. The Playwright suite that guards this
 * today (`test/chains.mjs`) is not ported until Phase 1, so for one phase
 * this file is the only thing preventing a spoiler regression (see the
 * Phase 0 plan, decision D9 and the "Engine tests" section).
 *
 * Also covers the Hermite/monotone-cubic maths in `ipos`/`pathTangents`
 * (decision D3) and the once-only tangent computation in `createAnimator`.
 */
import { describe, expect, it } from 'vitest';
import type { Mode } from '~/engine/state.js';
import type { Keyframe } from '~/types.js';
import { actor, answer, deepFreeze, kf, scenario, stepPick } from './helpers.js';

const { animLimit, createAnimator, ipos, pathTangents } = await import('~/engine/anim.js');

describe('animLimit — the spoiler gate', () => {
  const sc = scenario({ qAt: 3, dur: 5 });

  const cases: ReadonlyArray<{ mode: Mode; done: boolean; expected: number }> = [
    { mode: 'exam', done: false, expected: sc.qAt },
    { mode: 'exam', done: true, expected: sc.qAt },
    { mode: 'review', done: false, expected: sc.dur },
    { mode: 'review', done: true, expected: sc.dur },
    { mode: 'learn', done: false, expected: sc.qAt },
    { mode: 'learn', done: true, expected: sc.dur },
  ];

  it.each(cases)('mode=$mode done=$done → $expected', ({ mode, done, expected }) => {
    const a = answer({ done, steps: done ? [stepPick(0, true)] : [] });
    expect(animLimit({ mode, scenario: sc, answer: a })).toBe(expected);
  });

  it('exam always returns qAt regardless of how the answer looks, including a bogus done+ok mismatch', () => {
    const a = answer({ done: true, ok: false, steps: [stepPick(0, false), stepPick(0, false)] });
    expect(animLimit({ mode: 'exam', scenario: sc, answer: a })).toBe(sc.qAt);
  });

  it('review always returns dur even for a completely blank answer', () => {
    expect(animLimit({ mode: 'review', scenario: sc, answer: answer() })).toBe(sc.dur);
  });
});

describe('pathTangents', () => {
  it('is zero at both ends of the path', () => {
    const kfs: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 10, 0), kf(2, 5, 0), kf(3, 0, 0)];
    const m = pathTangents(kfs, 1);
    expect(m[0]).toBe(0);
    expect(m[m.length - 1]).toBe(0);
  });

  it('is zero wherever the direction reverses (d[i-1] * d[i] <= 0)', () => {
    // x: 0 -> 10 -> 5 -> 0: rises then falls. d0=10, d1=-5, d2=-5 → reversal at i=1.
    const kfs: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 10, 0), kf(2, 5, 0), kf(3, 0, 0)];
    const m = pathTangents(kfs, 1);
    expect(m[1]).toBe(0);
  });

  it('clamps |m[i]| to 3 * min(|d[i-1]|, |d[i]|) — the monotone Fritsch-Carlson clamp', () => {
    // x: 0 -> 1 -> 10 -> 19, unit time steps: d0=1, d1=9, d2=9.
    // Unclamped m[1] would be (1+9)/2=5; the clamp caps it at 3*min(1,9)=3.
    const kfs: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 1, 0), kf(2, 10, 0), kf(3, 19, 0)];
    const m = pathTangents(kfs, 1);
    expect(Math.abs(m[1])).toBeLessThanOrEqual(3);
    expect(m[1]).toBeCloseTo(3, 9);
  });

  it('never exceeds the clamp anywhere on a longer, wigglier path', () => {
    const kfs: readonly Keyframe[] = [
      kf(0, 0, 0),
      kf(1, 2, 0),
      kf(2, 40, 0),
      kf(3, 41, 0),
      kf(4, 0, 0),
      kf(5, -30, 0),
    ];
    const m = pathTangents(kfs, 1);
    for (let i = 1; i < kfs.length - 1; i++) {
      const a = (kfs[i + 1][1] - kfs[i][1]) / (kfs[i + 1][0] - kfs[i][0] || 1e-6);
      const b = (kfs[i][1] - kfs[i - 1][1]) / (kfs[i][0] - kfs[i - 1][0] || 1e-6);
      const lim = 3 * Math.min(Math.abs(a), Math.abs(b));
      expect(Math.abs(m[i])).toBeLessThanOrEqual(lim + 1e-9);
    }
  });
});

describe('ipos — no-overshoot per segment', () => {
  const eps = 1e-9;

  it('never leaves the [min, max] envelope of its own segment, on any axis, sampled densely', () => {
    const kfs: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 10, 5), kf(2, 3, 8), kf(3, 15, 2)];
    for (let i = 0; i < kfs.length - 1; i++) {
      const [t0] = kfs[i];
      const [t1] = kfs[i + 1];
      for (const axis of [1, 2] as const) {
        const a = kfs[i][axis];
        const b = kfs[i + 1][axis];
        const lo = Math.min(a, b) - eps;
        const hi = Math.max(a, b) + eps;
        for (let s = 0; s <= 200; s++) {
          const t = t0 + ((t1 - t0) * s) / 200;
          const v = ipos(kfs, t)[axis - 1];
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('regression: a rise-then-plateau path holds the plateau segment exactly constant', () => {
    // x: 0 -> 10 -> 10. A plain Catmull-Rom would dip below/swing past the
    // plateau; the monotone clamp must not.
    const kfs: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 10, 0), kf(2, 10, 0)];
    for (let s = 0; s <= 20; s++) {
      const t = 1 + s / 20;
      const [x] = ipos(kfs, t);
      expect(x).toBeCloseTo(10, 9);
    }
  });

  it('clamps to the first keyframe for t below kf[0][0]', () => {
    const kfs: readonly Keyframe[] = [kf(1, 5, 7), kf(2, 9, 3)];
    expect(ipos(kfs, 0)).toEqual([5, 7]);
    expect(ipos(kfs, -100)).toEqual([5, 7]);
  });

  it('clamps to the last keyframe for t at or beyond the final one', () => {
    const kfs: readonly Keyframe[] = [kf(0, 5, 7), kf(1, 9, 3)];
    expect(ipos(kfs, 1)).toEqual([9, 3]);
    expect(ipos(kfs, 100)).toEqual([9, 3]);
  });
});

describe('createAnimator', () => {
  it('computes tangents exactly once per path, not once per posAt/discAt call', () => {
    let calls = 0;
    const countingPathTangents: typeof pathTangents = (kfs, axis) => {
      calls++;
      return pathTangents(kfs, axis);
    };
    const sc = scenario({ actors: [actor({ id: 'O1' })] });
    const anim = createAnimator(sc, { pathTangents: countingPathTangents });

    for (let i = 0; i < 25; i++) anim.posAt('O1', i * 0.2);
    anim.discAt(0);
    anim.discAt(1);
    anim.discAt(2);

    // 1 actor * 2 axes + 1 disc * 2 axes = 4, regardless of the 28 calls above.
    expect(calls).toBe(4);
  });

  it('works on a deep-frozen scenario without throwing and without mutating it', () => {
    const sc = deepFreeze(scenario({ actors: [actor({ id: 'O1' })] }));
    const anim = createAnimator(sc);
    expect(() => anim.posAt('O1', 2)).not.toThrow();
    expect(() => anim.discAt(2)).not.toThrow();
    expect(Object.isFrozen(sc.actors[0]?.kf)).toBe(true);
    expect(Object.isFrozen(sc.disc.kf)).toBe(true);
  });

  it('posAt/discAt agree with directly calling ipos on the same keyframes', () => {
    const sc = scenario({ actors: [actor({ id: 'O1' })] });
    const anim = createAnimator(sc);
    const actorKf = sc.actors[0]?.kf as readonly Keyframe[];
    expect(anim.posAt('O1', 2)).toEqual(ipos(actorKf, 2));
    expect(anim.discAt(2)).toEqual(ipos(sc.disc.kf, 2));
  });

  it('posAt returns null for an id that resolves to no actor, rather than a silent [0, 0]', () => {
    const sc = scenario({ actors: [actor({ id: 'O1' })] });
    const anim = createAnimator(sc);
    expect(anim.posAt('TYPO', 2)).toBeNull();
  });

  it('a duplicate actor id: posAt uses the LAST actor sharing that id for both keyframes and tangents, never a mix of the two', () => {
    const firstKf: readonly Keyframe[] = [kf(0, 0, 0), kf(1, 10, 0)];
    const secondKf: readonly Keyframe[] = [kf(0, 5, 5), kf(1, 5, 25)];
    const sc = scenario({
      actors: [actor({ id: 'DUP', kf: firstKf }), actor({ id: 'DUP', kf: secondKf })],
    });
    const anim = createAnimator(sc);
    for (const t of [0, 0.3, 0.7, 1]) {
      expect(anim.posAt('DUP', t)).toEqual(ipos(secondKf, t));
    }
  });
});
