/**
 * G14 — duplication guard, ported from `duplication.mjs`.
 *
 * Deliberately NOT step-level: the same rule recurring across different
 * situations is the whole point of this trainer. Only a whole chain that
 * retreads another whole chain is a defect.
 *
 * No `console.log` reporting is ported — vitest swallows stdout from
 * passing tests, so it would be dead code (per the architect's instruction).
 * The pair list itself is snapshotted so a NEW pair crossing the WARN
 * threshold surfaces in review, even though nothing crosses it today.
 */
import { describe, expect, it } from 'vitest';
import type { RulesPackage } from '~/types.js';
import { basePackage, baseScenario, baseStep, loc, sid } from './fixtures.js';
import {
  chainSimilarity,
  DUPLICATION_FAIL,
  DUPLICATION_WARN,
  findClonePairs,
  jaccard,
  meanBestMatch,
  scoreScenarios,
  wordBag,
} from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

describe('scoring primitives (ported verbatim)', () => {
  it('wordBag strips stop-words (including domain words like "disc"/"play") and short tokens', () => {
    expect(wordBag('The disc is a call and the play is fast')).toEqual(new Set(['call', 'fast']));
  });

  it('jaccard of two empty bags is 0, not NaN', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('jaccard of identical bags is 1', () => {
    const a = new Set(['stall', 'count', 'violation']);
    expect(jaccard(a, new Set(a))).toBe(1);
  });

  it('meanBestMatch picks the single best match per short-side step, not an average of all', () => {
    const short = [{ rules: '', bag: new Set(['a']), aBag: new Set(['a']) }];
    const long = [
      { rules: '', bag: new Set(['a']), aBag: new Set(['a']) },
      { rules: '', bag: new Set(['z']), aBag: new Set(['z']) },
    ];
    expect(meanBestMatch(short, long, 'aBag')).toBe(1);
  });
});

describe('chainSimilarity', () => {
  it('scores an exact duplicate (same answers, same rules, same length) at 1.00', () => {
    const step = baseStep({ rules: ['7.8'] });
    const a = scoreScenarios([
      basePackage(1, [baseScenario({ id: sid('orig'), steps: [step] })]),
    ])[0]!;
    const b = scoreScenarios([
      basePackage(1, [baseScenario({ id: sid('clone'), steps: [step] })]),
    ])[0]!;
    expect(chainSimilarity(a, b).score).toBeCloseTo(1, 5);
  });

  it('scores two scenarios that share a rule citation but give different answers well below the clone threshold', () => {
    const stepA = baseStep({
      rules: ['7.8'],
      q: loc('Different question A'),
      opts: [
        { t: loc('First correct answer entirely'), ok: true, why: loc('w') },
        { t: loc('other'), why: loc('w') },
      ],
    });
    const stepB = baseStep({
      rules: ['7.8'],
      q: loc('Different question B'),
      opts: [
        { t: loc('Second unrelated response'), ok: true, why: loc('w') },
        { t: loc('other'), why: loc('w') },
      ],
    });
    const a = scoreScenarios([
      basePackage(1, [baseScenario({ id: sid('a'), steps: [stepA] })]),
    ])[0]!;
    const b = scoreScenarios([
      basePackage(1, [baseScenario({ id: sid('b'), steps: [stepB] })]),
    ])[0]!;
    expect(chainSimilarity(a, b).score).toBeLessThan(DUPLICATION_WARN);
  });

  it('returns score 0 when either scenario has no steps', () => {
    const withSteps = scoreScenarios([basePackage(1, [baseScenario({ id: sid('has') })])])[0]!;
    const empty = { id: 'empty', title: 'Empty', steps: [] };
    expect(chainSimilarity(withSteps, empty).score).toBe(0);
  });
});

describe('G14 — no scenario retreads another scenario’s whole chain', () => {
  it('real content: empty pair list at the 0.4 WARN threshold', () => {
    const scenarios = scoreScenarios(ALL_PACKAGES);
    const pairs = findClonePairs(scenarios, DUPLICATION_WARN);
    expect(pairs).toEqual([]);
    // Snapshotted too (redundant with the assertion above while it's empty)
    // so a NEW warn-tier pair is visible as a snapshot diff in review, not
    // just a boolean pass/fail.
    expect(pairs).toMatchSnapshot();
  });

  it('bites: an injected reworded near-clone scores at/above the FAIL threshold', () => {
    const original: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('orig'),
          rules: ['7.8'],
          steps: [
            baseStep({
              rules: ['7.8'],
              q: loc('The receiver touches the disc before it lands — what is the result?'),
              opts: [
                {
                  t: loc('Turnover — the pull is dropped'),
                  ok: true,
                  why: loc('touching before it lands is a drop'),
                },
                {
                  t: loc('Live ball, play on'),
                  why: loc('no, contact before landing ends the play'),
                },
              ],
            }),
          ],
        }),
      ]),
    ];
    // Reworded prompt, IDENTICAL rule citation and answer text — this is
    // exactly the failure mode the guard's header comment describes: the
    // real clone this guard was built to catch reworded its prompts but
    // kept the same rule numbers and answers.
    const reworded: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('reworded'),
          rules: ['7.8'],
          steps: [
            baseStep({
              rules: ['7.8'],
              q: loc('A receiver gets a hand on the disc before it hits the ground — call it.'),
              opts: [
                {
                  t: loc('Turnover — the pull is dropped'),
                  ok: true,
                  why: loc('touching before it lands is a drop'),
                },
                {
                  t: loc('Live ball, play on'),
                  why: loc('no, contact before landing ends the play'),
                },
              ],
            }),
          ],
        }),
      ]),
    ];
    const scenarios = scoreScenarios([...original, ...reworded]);
    const pairs = findClonePairs(scenarios, DUPLICATION_WARN);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.score).toBeGreaterThanOrEqual(DUPLICATION_FAIL);
  });
});
