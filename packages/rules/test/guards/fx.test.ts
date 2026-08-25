/**
 * fx-shape guards: view containment (G10, including arrows) and the fx
 * type / mark kind enum (G12).
 */
import { describe, expect, it } from 'vitest';
import type { Fx, RulesPackage } from '~/types.js';
import { basePackage, baseScenario, sid } from './fixtures.js';
import { findInvalidFx, findOutOfViewPoints } from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

describe('G10 — actor/disc/fx coordinates are inside the scenario view', () => {
  it('real content: actors and discs never render off-screen', () => {
    // Scoped assertion so a real actor/disc failure is distinguishable from
    // an arrow failure in the report below.
    const problems = findOutOfViewPoints(ALL_PACKAGES);
    const nonArrow = problems.filter((p) => !p.includes('fx arrow'));
    expect(nonArrow).toEqual([]);
  });

  it('real content: all 16 arrow fx are inside their own scenario view', () => {
    // This is the gap the plan calls out: `build.mjs`'s `if (f.x !== undefined)`
    // skips every arrow (coords are x1/y1/x2/y2, not x/y), so this is the
    // first time arrows have ever been checked. Verified independently by
    // hand against the raw JSON — all 16 pass — but this test is what keeps
    // that true.
    const arrowProblems = findOutOfViewPoints(ALL_PACKAGES).filter((p) => p.includes('fx arrow'));
    expect(arrowProblems).toEqual([]);
  });

  it('bites: an actor keyframe placed outside its own scenario view', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('offview'),
          view: [0, 0, 10, 10],
          actors: [
            { id: 'O1', team: 'off', label: 'O1', you: true, kf: [[0, 500, 500]] },
            { id: 'D1', team: 'def', label: 'D1', kf: [[0, 5, 5]] },
          ],
        }),
      ]),
    ];
    // The fixture's default disc keyframes also sit outside this deliberately
    // tiny view, so assert the injected defect is REPORTED rather than that it
    // is the only report — otherwise the test breaks whenever the fixture's
    // unrelated defaults change.
    const problems = findOutOfViewPoints(bad);
    expect(problems).toContain('offview: actor O1 at (500,500) is outside view [0,0,10,10]');
  });

  it('bites: an arrow fx whose second endpoint is outside the view', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('badarrow'),
          view: [0, 0, 10, 10],
          fx: [{ t: 1, type: 'arrow', x1: 1, y1: 1, x2: 999, y2: 999 }],
        }),
      ]),
    ];
    const problems = findOutOfViewPoints(bad);
    expect(problems).toContain('badarrow: fx arrow end (999,999) is outside view [0,0,10,10]');
  });
});

describe('G12 — fx type and mark kind enums', () => {
  it('real content only uses known fx types and mark kinds', () => {
    expect(findInvalidFx(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: an fx with an unknown type', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('badtype'),
          fx: [{ t: 1, type: 'zone' } as unknown as Fx],
        }),
      ]),
    ];
    expect(findInvalidFx(bad)).toEqual([
      'badtype: fx type "zone" is not one of bubble|flash|mark|arrow',
    ]);
  });

  it('bites: a mark fx with an unknown kind', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('badkind'),
          fx: [
            {
              t: 1,
              type: 'mark',
              kind: 'circle',
              x: 1,
              y: 1,
              label: { en: 'x', cs: 'x' },
            } as unknown as Fx,
          ],
        }),
      ]),
    ];
    expect(findInvalidFx(bad)).toEqual([
      'badkind: mark kind "circle" is not one of x|target|zone|dot',
    ]);
  });
});
