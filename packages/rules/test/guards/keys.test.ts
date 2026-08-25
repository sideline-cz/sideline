/**
 * G13 — no unknown keys at any level (scenario, actor, disc, step, option,
 * fx-per-type), driven off `src/types.ts`'s own shapes.
 *
 * This guard is what surfaced the third content cleanup of the port. On
 * first run it flagged 57 dead `r` values authored on `x`/`target`/`dot`
 * marks — `buildFx` in the source app reads `f.r` only inside the `zone`
 * branch, so `r` on any other mark kind was present, authored and never
 * read: exactly the defect class as the dead `options` field. Those 57 were
 * deleted (the 12 functional `zone` values were kept), so the guard is green
 * and now protects against the next such field accumulating silently.
 */
import { describe, expect, it } from 'vitest';
import type { Fx, RulesPackage } from '~/types.js';
import { basePackage, baseScenario, sid } from './fixtures.js';
import { findUnknownKeys } from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

describe('G13 — no unknown keys anywhere in content', () => {
  it('real content has no unknown keys', () => {
    // Green because the 57 dead `r` values this guard originally flagged were
    // deleted, not because the guard was loosened to accept them — see the
    // `kind === 'zone'` narrowing in `lib.ts`.
    expect(findUnknownKeys(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: a scenario-level key that does not exist in the type', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [{ ...baseScenario({ id: sid('extra') }), bogus: true } as never]),
    ];
    expect(findUnknownKeys(bad)).toEqual(['extra: unknown scenario key "bogus"']);
  });

  it('bites: an actor-level key that does not exist in the type', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('actorextra'),
          actors: [
            { id: 'O1', team: 'off', label: 'O1', you: true, kf: [[0, 10, 10]], speed: 5 } as never,
            { id: 'D1', team: 'def', label: 'D1', kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findUnknownKeys(bad)).toEqual(['actorextra: unknown actor key "speed" on O1']);
  });

  it('bites: `r` on a mark fx whose kind is `x` (not `zone`) — the exact defect class G13 exists to catch', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('deadr'),
          fx: [
            {
              t: 1,
              type: 'mark',
              kind: 'x',
              x: 1,
              y: 1,
              label: { en: 'x', cs: 'x' },
              r: 1,
            } as Fx,
          ],
        }),
      ]),
    ];
    expect(findUnknownKeys(bad)).toEqual(['deadr: fx (mark) has unknown key "r"']);
  });

  it('does not flag `r` on a mark fx whose kind is `zone` — that is the one kind that reads it', () => {
    const ok: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('zoner'),
          fx: [
            {
              t: 1,
              type: 'mark',
              kind: 'zone',
              x: 1,
              y: 1,
              label: { en: 'x', cs: 'x' },
              r: 3,
            } as Fx,
          ],
        }),
      ]),
    ];
    expect(findUnknownKeys(ok)).toEqual([]);
  });

  it('bites: a package-level key that does not exist in RulesPackage', () => {
    const bad: readonly RulesPackage[] = [
      { ...basePackage(1, [baseScenario({ id: sid('pkgextra') })]), author: 'someone' } as never,
    ];
    expect(findUnknownKeys(bad)).toEqual(['level 1 package: unknown package key "author"']);
  });

  it('bites: a stray language key on a Localized field, not caught by G9 (which only checks en/cs are present)', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('straylang'),
          title: { en: 'title', cs: 'title', de: 'Titel' } as never,
        }),
      ]),
    ];
    expect(findUnknownKeys(bad)).toEqual(['straylang.title: unknown language "de"']);
  });

  it('bites: an option-level key that does not exist in the type', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('optextra'),
          steps: [
            {
              k: 'result',
              q: { en: 'q', cs: 'q' },
              rules: [],
              opts: [
                {
                  t: { en: 'a', cs: 'a' },
                  ok: true,
                  why: { en: 'w', cs: 'w' },
                  points: 5,
                } as never,
                { t: { en: 'b', cs: 'b' }, why: { en: 'w', cs: 'w' } },
              ],
            },
          ],
        }),
      ]),
    ];
    expect(findUnknownKeys(bad)).toEqual(['optextra step 1 option 1: unknown option key "points"']);
  });
});
