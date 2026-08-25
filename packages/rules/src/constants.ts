import type { Level, Localized } from './types.js';

export const LEVELS: readonly Level[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const EXAM_N = 10;

export type LevelMeta = {
  readonly level: Level;
  readonly name: Localized<string>;
  readonly scenarioCount: number;
};

/**
 * Hand-maintained mirror of the content, deliberately not computed from
 * `ALL_PACKAGES` — the `.` entry point must not pull any package JSON into
 * the graph (see the Phase 0 plan, decision D1). A `G17` guard
 * (`LEVEL_META[l].scenarioCount === countLevel(l)`) belongs with the engine
 * step to catch drift.
 *
 * `name.en` is copied verbatim from each package's own `name` field (which
 * is English-only in the source content). `name.cs` is reconstructed as
 * `Level N · {topic.cs}` using each level's now-canonical `topic.cs` (see
 * decision D10) — the package JSON has no Czech `name` of its own, and
 * `ui.json`'s `levels` array (which does) is explicitly a Phase 1 i18n
 * catalogue input, not something this package's source may read.
 */
export const LEVEL_META: Readonly<Record<Level, LevelMeta>> = {
  1: {
    level: 1,
    name: { en: 'Level 1 · The pull', cs: 'Level 1 · Pull' },
    scenarioCount: 13,
  },
  2: {
    level: 2,
    name: { en: 'Level 2 · Marking infractions', cs: 'Level 2 · Marking infractions' },
    scenarioCount: 9,
  },
  3: {
    level: 3,
    name: { en: 'Level 3 · Receiving fouls', cs: 'Level 3 · Fauly při chytání' },
    scenarioCount: 16,
  },
  4: {
    level: 4,
    name: { en: 'Level 4 · Thrower & marker fouls', cs: 'Level 4 · Fauly házeče a markera' },
    scenarioCount: 9,
  },
  5: {
    level: 5,
    name: { en: 'Level 5 · Travel', cs: 'Level 5 · Travel' },
    scenarioCount: 9,
  },
  6: {
    level: 6,
    name: { en: 'Level 6 · Picks', cs: 'Level 6 · Picky' },
    scenarioCount: 9,
  },
  7: {
    level: 7,
    name: { en: 'Level 7 · Stall count', cs: 'Level 7 · Stall count' },
    scenarioCount: 13,
  },
  8: {
    level: 8,
    name: { en: 'Level 8 · Out of bounds', cs: 'Level 8 · Aut' },
    scenarioCount: 11,
  },
  9: {
    level: 9,
    name: { en: 'Level 9 · Stoppages', cs: 'Level 9 · Přerušení' },
    scenarioCount: 20,
  },
};
