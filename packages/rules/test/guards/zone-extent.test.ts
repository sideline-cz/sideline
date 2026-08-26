/**
 * G20 — a `mark`/`zone` fx fits entirely inside its scenario's `view`.
 *
 * The companion to G10: that guard checks fx *centres*, which catches an
 * annotation rendered wholly off-screen. A zone is the only fx with an
 * authored extent (`r`), so its centre can be well inside the view while the
 * circle is clipped at the edge — invisible to a centre-only check.
 */
import { describe, expect, it } from 'vitest';
import type { RulesPackage } from '~/types.js';
import { basePackage, baseScenario, loc, sid } from './fixtures.js';
import { findZoneExtentViolations } from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

const zone = (x: number, y: number, r?: number) => ({
  t: 1,
  type: 'mark' as const,
  kind: 'zone' as const,
  x,
  y,
  ...(r === undefined ? {} : { r }),
  label: loc('a zone'),
});

describe('G20 — zone extents fit their view', () => {
  it('real content: every zone circle is fully visible', () => {
    expect(findZoneExtentViolations(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: a zone clipped by the top edge — the ob6 case that introduced this guard', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({ id: sid('clipped'), view: [56, -6, 48, 48], fx: [zone(81, -3.2, 3)] }),
      ]),
    ];
    expect(findZoneExtentViolations(bad)).toEqual([
      'clipped: zone at (81,-3.2) r=3 overflows view [56,-6,48,48] — top by 0.20',
    ]);
  });

  it('bites on every edge, and reports each overflow', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({ id: sid('huge'), view: [0, 0, 20, 20], fx: [zone(10, 10, 50)] }),
      ]),
    ];
    const problems = findZoneExtentViolations(bad);
    expect(problems).toHaveLength(1);
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      expect(problems[0]).toContain(edge);
    }
  });

  it('assumes the renderer default r=3 when r is absent, or it would under-check', () => {
    // `buildFx` draws `f.r || 3`, so a zone with no `r` is a radius-3 circle.
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({ id: sid('defaulted'), view: [0, 0, 20, 20], fx: [zone(1, 10)] }),
      ]),
    ];
    expect(findZoneExtentViolations(bad)).toEqual([
      'defaulted: zone at (1,10) r=3 overflows view [0,0,20,20] — left by 2.00',
    ]);
  });

  it('passes a zone that exactly touches the edge — flush is visible, not clipped', () => {
    const ok: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({ id: sid('flush'), view: [0, 0, 20, 20], fx: [zone(3, 10, 3)] }),
      ]),
    ];
    expect(findZoneExtentViolations(ok)).toEqual([]);
  });

  it('ignores non-zone marks, whose radii are hardcoded by the renderer', () => {
    const ok: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('xmark'),
          view: [0, 0, 20, 20],
          fx: [{ t: 1, type: 'mark', kind: 'x', x: 0, y: 0, label: loc('x') }],
        }),
      ]),
    ];
    expect(findZoneExtentViolations(ok)).toEqual([]);
  });
});
