/**
 * G18 — numeric/shape guard. See `lib.ts`'s doc comment on
 * `findShapeViolations` for why `dur` needed the exact same treatment `qAt`
 * already got from G4/G5, and for the full list of defect classes below.
 */
import { describe, expect, it } from 'vitest';
import type { RulesPackage, Scenario } from '~/types.js';
import { basePackage, baseScenario, sid } from './fixtures.js';
import { findShapeViolations } from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

describe('G18 — dur/qAt/view/kf/fx/opts shape', () => {
  it('real content has no shape violations', () => {
    expect(findShapeViolations(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: a scenario with no dur at all — satisfies every other guard, but breaks animLimit', () => {
    const { dur: _dur, ...rest } = baseScenario({ id: sid('nodur') });
    const bad: readonly RulesPackage[] = [basePackage(1, [rest as unknown as Scenario])];
    const problems = findShapeViolations(bad);
    expect(problems).toContain('nodur: qAt (3) and dur (undefined) must satisfy 0 <= qAt < dur');
  });

  it('bites: qAt authored as a string — ">=" would silently coerce it', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [{ ...baseScenario({ id: sid('strqat') }), qAt: '3' } as unknown as Scenario]),
    ];
    const problems = findShapeViolations(bad);
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('strqat: qAt (3) and dur')]),
    );
  });

  it('bites: a negative qAt', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [baseScenario({ id: sid('negqat'), qAt: -5 })]),
    ];
    const problems = findShapeViolations(bad);
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('negqat: qAt (-5) and dur')]),
    );
  });

  it('bites: view without exactly 4 entries', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        {
          ...baseScenario({ id: sid('badview') }),
          view: [0, 0, 100] as unknown as Scenario['view'],
        },
      ]),
    ];
    expect(findShapeViolations(bad)).toContain('badview: view does not have exactly 4 entries');
  });

  it('bites: a non-positive view width/height', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [baseScenario({ id: sid('zerowh'), view: [0, 0, 0, 37] })]),
    ];
    expect(findShapeViolations(bad)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('zerowh: view width/height must be positive'),
      ]),
    );
  });

  it('bites: an actor with an empty kf', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('emptykf'),
          actors: [
            { id: 'O1', team: 'off', label: 'O1', you: true, kf: [] },
            { id: 'D1', team: 'def', label: 'D1', kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toContain('emptykf: actor O1: kf is empty');
  });

  it('bites: a disc with an empty kf', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [baseScenario({ id: sid('emptydisc'), disc: { kf: [] } })]),
    ];
    expect(findShapeViolations(bad)).toContain('emptydisc: disc: kf is empty');
  });

  it('bites: non-monotonic keyframe times', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('badtime'),
          actors: [
            {
              id: 'O1',
              team: 'off',
              label: 'O1',
              you: true,
              kf: [
                [0, 10, 10],
                [5, 20, 20],
                [2, 15, 15],
              ],
            },
            { id: 'D1', team: 'def', label: 'D1', kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toEqual(
      expect.arrayContaining([expect.stringContaining('badtime: actor O1: keyframe 2 has t 2')]),
    );
  });

  it('bites: an fx whose t is after the scenario dur', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('fxlate'),
          dur: 5,
          fx: [{ t: 99, type: 'flash', x: 1, y: 1 }],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toContain('fxlate: fx at t=99 is after dur (5)');
  });

  it('bites: a bubble fx whose actor id does not resolve to a real actor', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('ghostbubble'),
          fx: [
            {
              t: 1,
              type: 'bubble',
              dur: 1,
              actor: 'GHOST',
              text: { en: 'x', cs: 'x' },
              style: 'call',
            },
          ],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toContain(
      'ghostbubble: bubble fx references unknown actor "GHOST"',
    );
  });

  it('bites: a step with only one option', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('oneopt'),
          steps: [
            {
              k: 'result',
              q: { en: 'q', cs: 'q' },
              rules: [],
              opts: [{ t: { en: 'only', cs: 'only' }, ok: true, why: { en: 'w', cs: 'w' } }],
            },
          ],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toContain(
      'oneopt step 1: only 1 option(s), expected at least 2',
    );
  });

  it('bites: two actors sharing an id within the same scenario', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('dupactor'),
          actors: [
            { id: 'X', team: 'off', label: 'X', you: true, kf: [[0, 10, 10]] },
            { id: 'X', team: 'def', label: 'X2', kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findShapeViolations(bad)).toContain('dupactor: duplicate actor id "X"');
  });
});
