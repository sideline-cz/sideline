/**
 * Content sanity guards ported from `frisbee-rules/build.mjs`, plus the
 * three new Phase 0 guards (G15–G17) the plan doc calls for.
 *
 * These import `~/content.js` and `~/reference.js` — never
 * `@sideline/rules/content` — because there is no `rules` alias in the root
 * `vitest.config.ts`, and this package's own `vitest.config.ts` only aliases
 * `~`, so the bare package specifier would resolve through `node_modules` →
 * `exports` → a possibly-stale `dist`. See `packages/rules/AGENTS.md`.
 */
import { describe, expect, it } from 'vitest';
import { LEVEL_META } from '~/constants.js';
import { RULES, SIGNALS } from '~/reference.js';
import type { RulesPackage } from '~/types.js';
import { basePackage, baseScenario, loc, sid } from './fixtures.js';
import {
  findDuplicateScenarioIds,
  findEmptyChains,
  findLevelMismatches,
  findMissingLanguages,
  findMissingQAt,
  findMultipleTopicsPerLevel,
  findQAtNotBeforeDur,
  findScenarioCountMismatches,
  findUnresolvedRules,
  findUnresolvedSignals,
  findWrongOkCounts,
  findYouActorCountViolations,
} from './lib.js';

// `~/content.js` is the eager barrel — never load it from `applications/web`.
const { ALL_PACKAGES } = await import('~/content.js');

describe('G1 — no duplicate scenario id across packages', () => {
  it('real content has none', () => {
    expect(findDuplicateScenarioIds(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G2 — sc.level equals its owning package level', () => {
  it('real content matches', () => {
    expect(findLevelMismatches(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G3 — non-empty chain on every scenario', () => {
  it('real content has a chain everywhere', () => {
    expect(findEmptyChains(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G4 — qAt is defined', () => {
  it('real content always defines qAt', () => {
    expect(findMissingQAt(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G5 — qAt < dur', () => {
  it('real content never lets qAt catch up with dur', () => {
    expect(findQAtNotBeforeDur(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G6 — exactly one ok:true per step', () => {
  it('real content has exactly one correct option per step', () => {
    expect(findWrongOkCounts(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G7 — scenario and step rules[] resolve in rules.json', () => {
  it('real content only cites known rule numbers', () => {
    expect(findUnresolvedRules(ALL_PACKAGES, RULES)).toEqual([]);
  });
});

describe('G8 — signals[] resolve in signals.json', () => {
  it('real content only cites known hand signals', () => {
    expect(findUnresolvedSignals(ALL_PACKAGES, SIGNALS)).toEqual([]);
  });
});

describe('G9 — both languages present on every text field', () => {
  it('real content is fully bilingual', () => {
    expect(findMissingLanguages(ALL_PACKAGES)).toEqual([]);
  });
});

describe('G15 — exactly one topic.en per level', () => {
  it('real content has 9 distinct topics, one per level', () => {
    expect(findMultipleTopicsPerLevel(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: two scenarios in the same level authored under different topic strings', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({ id: sid('a1'), level: 1, topic: loc('The pull') }),
        baseScenario({ id: sid('a2'), level: 1, topic: loc('Pull') }),
      ]),
    ];
    const problems = findMultipleTopicsPerLevel(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('level 1');
  });
});

describe('G16 — exactly one you actor per scenario', () => {
  it('real content marks exactly one actor you in every scenario', () => {
    expect(findYouActorCountViolations(ALL_PACKAGES)).toEqual([]);
  });

  it('bites: a scenario with zero you actors', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('novou'),
          actors: [
            { id: 'O1', team: 'off', label: 'O1', kf: [[0, 10, 10]] },
            { id: 'D1', team: 'def', label: 'D1', kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findYouActorCountViolations(bad)).toEqual([
      `novou: 0 actors marked you, expected exactly 1`,
    ]);
  });

  it('bites: a scenario with two you actors', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [
        baseScenario({
          id: sid('twoyou'),
          actors: [
            { id: 'O1', team: 'off', label: 'O1', you: true, kf: [[0, 10, 10]] },
            { id: 'O2', team: 'off', label: 'O2', you: true, kf: [[0, 20, 20]] },
          ],
        }),
      ]),
    ];
    expect(findYouActorCountViolations(bad)).toEqual([
      `twoyou: 2 actors marked you, expected exactly 1`,
    ]);
  });
});

describe('G17 — LEVEL_META[l].scenarioCount matches the actual count', () => {
  it('real content matches the hand-maintained LEVEL_META', () => {
    expect(findScenarioCountMismatches(ALL_PACKAGES, LEVEL_META)).toEqual([]);
  });

  it('bites: LEVEL_META claims a count the content does not have', () => {
    const bad: readonly RulesPackage[] = [
      basePackage(1, [baseScenario({ id: sid('only1'), level: 1 })]),
    ];
    const wrongMeta = { 1: { level: 1 as const, name: loc('Level 1'), scenarioCount: 13 } };
    const problems = findScenarioCountMismatches(bad, wrongMeta);
    expect(problems).toEqual(['LEVEL_META[1].scenarioCount is 13 but actual count is 1']);
  });
});
