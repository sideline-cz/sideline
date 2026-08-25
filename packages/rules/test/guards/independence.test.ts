/**
 * G11 — independence: no cross-reference between scenarios/steps, and no
 * hard-coded scenario count anywhere (content or `authoring/ui.json`).
 *
 * Ported from `independence.mjs`. `ui.json` lives outside `src/` (it is a
 * Phase 1 i18n-catalogue input, never read at runtime — see
 * `packages/rules/AGENTS.md`), so it is read here via `node:fs`, exactly
 * like the original script did, rather than a static import — a static
 * import of a JSON file outside both `src/` and `test/`'s own tsconfig
 * `include` would hit the same `TS6307` problem `AGENTS.md` documents for
 * `resolveJsonModule` under this repo's composite project-references setup.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RulesPackage } from '~/types.js';
import { basePackage, baseScenario, loc, sid } from './fixtures.js';
import {
  CROSS_REFERENCE,
  findHardcodedCountsInUi,
  findIndependenceViolations,
  HARDCODED_COUNT,
} from './lib.js';

const { ALL_PACKAGES } = await import('~/content.js');

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_JSON_PATH = join(PACKAGE_ROOT, 'authoring', 'ui.json');

describe('regexes (ported verbatim from independence.mjs)', () => {
  it('CROSS_REFERENCE matches known offending phrases', () => {
    expect(CROSS_REFERENCE.test('Same stack, same block as before')).toBe(true);
    expect(CROSS_REFERENCE.test('as we saw in scenario 11')).toBe(true);
    expect(CROSS_REFERENCE.test('this package covers marking')).toBe(true);
    expect(CROSS_REFERENCE.test('Obrácená perspektiva tady')).toBe(true);
  });

  it('CROSS_REFERENCE does not match ordinary prose', () => {
    expect(CROSS_REFERENCE.test('The disc lands out of bounds near the sideline.')).toBe(false);
  });

  it('HARDCODED_COUNT matches a bare scenario count (English)', () => {
    expect(HARDCODED_COUNT.test('there are 23 game situations here')).toBe(true);
    expect(HARDCODED_COUNT.test('there are 23 situations here')).toBe(true);
  });

  it('HARDCODED_COUNT does not match an unrelated number', () => {
    expect(HARDCODED_COUNT.test('the stall count reaches 7')).toBe(false);
  });

  it('REGRESSION: the Czech alternatives actually match (they never did in independence.mjs)', () => {
    // The ported script used a trailing `\b`, which in JavaScript is defined
    // against ASCII `\w` regardless of flags. "situací" ends in "í" — a
    // non-word character by that definition — so the boundary could only fire
    // when an ASCII word character followed with no space, which never happens
    // in prose. Both Czech alternatives were dead and the guard checked English
    // only, on the half of the content that is AI-written and unreviewed.
    // Fixed in `lib.ts` with a Unicode-aware negative lookahead; these three
    // cases returned false before that change.
    expect(HARDCODED_COUNT.test('109 situací v tomto balíčku')).toBe(true);
    expect(HARDCODED_COUNT.test('109 situací.')).toBe(true);
    expect(HARDCODED_COUNT.test('109 herních situací v tomto balíčku')).toBe(true);
  });

  it('still does not match a count embedded in a longer word', () => {
    // The lookahead must preserve the original trailing-boundary intent.
    expect(HARDCODED_COUNT.test('23 situationsXY')).toBe(false);
    expect(HARDCODED_COUNT.test('109 situacích')).toBe(false);
  });
});

describe('G11 — no cross-reference or hard-coded count in scenario content', () => {
  it('real content stands alone: no scenario leans on another', () => {
    expect(findIndependenceViolations(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: a situation that cross-references "scenario 11"', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('leans'),
          situation: loc('Same as scenario 11, but this time you catch it.'),
        }),
      ]),
    ];
    // `loc()` puts the same text in both languages, and the guard checks each
    // language independently — so one authored defect correctly yields two
    // reports. Assert on the English one instead of the total count.
    const problems = findIndependenceViolations(bad);
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('leans.situation.en')]),
    );
    expect(problems.join('\n')).toContain('cross-reference');
  });

  it('bites: a step question with a hard-coded scenario count', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('counted'),
          steps: [
            {
              k: 'result',
              q: loc('One of 33 game situations — what happens next?'),
              rules: [],
              opts: [
                { t: loc('a'), ok: true, why: loc('w') },
                { t: loc('b'), why: loc('w') },
              ],
            },
          ],
        }),
      ]),
    ];
    const problems = findIndependenceViolations(bad);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('counted.step1.en')]));
    expect(problems.join('\n')).toContain('hard-coded count');
  });
});

describe('G11 — no hard-coded count in authoring/ui.json', () => {
  it('real ui.json never states a scenario count', () => {
    const ui = JSON.parse(readFileSync(UI_JSON_PATH, 'utf8')) as Record<string, unknown>;
    expect(findHardcodedCountsInUi(ui)).toEqual([]);
  });

  it('bites: a UI string claiming "23 game situations", in BOTH languages', () => {
    // Both languages are asserted now. Before the `HARDCODED_COUNT` fix the
    // Czech entry was silently missed here too — same dead-regex limitation,
    // exercised through this guard's other entry point.
    const bad = { statSituations: { en: '23 game situations', cs: '23 herních situací' } };
    const problems = findHardcodedCountsInUi(bad);
    expect(problems).toEqual([
      'UI.statSituations.en: hard-coded count — "23 game situations"',
      'UI.statSituations.cs: hard-coded count — "23 herních situací"',
    ]);
  });
});
