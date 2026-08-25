/**
 * `pool` / `poolLen` / `posOf` / `countLevel` — a practice run covers only
 * the selected packages (levels); the pool is always a list of
 * `ScenarioId`s (Phase 0 plan, decision D8), never array indices, and
 * authored order is preserved so `posOf` matches what a user sees.
 */
import { describe, expect, it } from 'vitest';
import type { Level } from '~/types.js';
import { scenario, sid } from './helpers.js';

const { countLevel, pool, poolLen, posOf } = await import('~/engine/pool.js');

const scenarios = [
  scenario({ id: sid('a'), level: 1 }),
  scenario({ id: sid('b'), level: 2 }),
  scenario({ id: sid('c'), level: 1 }),
  scenario({ id: sid('d'), level: 3 }),
  scenario({ id: sid('e'), level: 2 }),
];

describe('pool', () => {
  it('returns only scenarios whose level is in sel', () => {
    expect(pool(scenarios, [1])).toEqual([sid('a'), sid('c')]);
  });

  it('preserves authored order across levels', () => {
    expect(pool(scenarios, [1, 2] as readonly Level[])).toEqual([
      sid('a'),
      sid('b'),
      sid('c'),
      sid('e'),
    ]);
  });

  it('returns an empty pool for an empty selection', () => {
    expect(pool(scenarios, [])).toEqual([]);
  });

  it('returns everything when every level is selected', () => {
    expect(pool(scenarios, [1, 2, 3])).toEqual(scenarios.map((s) => s.id));
  });
});

describe('poolLen', () => {
  it('matches pool(...).length', () => {
    expect(poolLen(scenarios, [1, 2])).toBe(pool(scenarios, [1, 2]).length);
    expect(poolLen(scenarios, [1, 2])).toBe(4);
  });
});

describe('posOf', () => {
  it('is 1-indexed within the pool', () => {
    expect(posOf(scenarios, [1, 2], sid('a'))).toBe(1);
    expect(posOf(scenarios, [1, 2], sid('b'))).toBe(2);
    expect(posOf(scenarios, [1, 2], sid('e'))).toBe(4);
  });

  it('is 0 for a scenario outside the current pool', () => {
    expect(posOf(scenarios, [1, 2], sid('d'))).toBe(0);
    expect(posOf(scenarios, [1, 2], sid('does-not-exist'))).toBe(0);
  });
});

describe('countLevel', () => {
  it('counts scenarios at a level, independent of any selection', () => {
    expect(countLevel(scenarios, 1)).toBe(2);
    expect(countLevel(scenarios, 2)).toBe(2);
    expect(countLevel(scenarios, 3)).toBe(1);
  });

  it('is 0 for a level with no scenarios', () => {
    expect(countLevel(scenarios, 9)).toBe(0);
  });
});
