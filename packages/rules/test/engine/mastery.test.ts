/**
 * Decaying mastery. These tests pin the *semantics* Phase 2's schema and
 * Phase 3's leaderboard are both built on, so they assert properties (a
 * half-life halves; weighting cannot be gamed) rather than transcribing the
 * arithmetic — a test that recomputes `2 ** (-d/h)` alongside the
 * implementation would pass for any exponent.
 */

import { describe, expect, it } from 'vitest';
import type { Level, ScenarioId } from '~/types.js';

const {
  MASTERED_THRESHOLD,
  MASTERY_HALF_LIFE_DAYS,
  overallMastery,
  packageMastery,
  scenarioStrength,
} = await import('~/engine/mastery.js');

const sid = (s: string): ScenarioId => s as ScenarioId;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const ago = (days: number) => NOW - days * DAY;

describe('scenarioStrength', () => {
  it('is 0 for a scenario never answered correctly', () => {
    expect(scenarioStrength(null, NOW)).toBe(0);
  });

  it('is 1 the instant it is answered', () => {
    expect(scenarioStrength(NOW, NOW)).toBe(1);
  });

  it('halves after exactly one half-life', () => {
    expect(scenarioStrength(ago(MASTERY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 10);
  });

  it('quarters after two half-lives', () => {
    expect(scenarioStrength(ago(2 * MASTERY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.25, 10);
  });

  it('decays monotonically and never reaches zero', () => {
    let previous = 1.1;
    for (const days of [0, 1, 10, 45, 90, 365, 3650]) {
      const s = scenarioStrength(ago(days), NOW);
      expect(s).toBeLessThan(previous);
      expect(s).toBeGreaterThan(0);
      previous = s;
    }
  });

  it('clamps a future timestamp to 1 rather than exceeding it', () => {
    // Client clocks are wrong constantly; a device an hour fast must not be
    // able to report more than full strength.
    expect(scenarioStrength(NOW + 60 * 60 * 1000, NOW)).toBe(1);
    expect(scenarioStrength(NOW + 365 * DAY, NOW)).toBe(1);
  });

  it('treats non-finite input as never-correct rather than producing NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(scenarioStrength(bad, NOW)).toBe(0);
      expect(scenarioStrength(NOW, bad)).toBe(0);
    }
  });

  it('respects a custom half-life', () => {
    expect(scenarioStrength(ago(10), NOW, 10)).toBeCloseTo(0.5, 10);
    expect(scenarioStrength(ago(10), NOW, 20)).toBeGreaterThan(0.5);
  });

  it('does not divide by zero or invert on a non-positive half-life', () => {
    expect(scenarioStrength(ago(1), NOW, 0)).toBe(0);
    expect(scenarioStrength(ago(1), NOW, -5)).toBe(0);
    expect(Number.isFinite(scenarioStrength(ago(1), NOW, 0))).toBe(true);
  });
});

describe('packageMastery', () => {
  const ids = [sid('a'), sid('b'), sid('c'), sid('d')];
  const level = 1 as Level;

  it('is 0 and not mastered for an empty package — never NaN', () => {
    const m = packageMastery(level, [], [], NOW);
    expect(m.strength).toBe(0);
    expect(m.mastered).toBe(false);
    expect(Number.isNaN(m.strength)).toBe(false);
  });

  it('counts unanswered scenarios as 0, so partial practice is not mastery', () => {
    // Only one of four answered — mastery must not be reachable by drilling a
    // single situation.
    const m = packageMastery(level, ids, [{ scenarioId: sid('a'), lastCorrectAt: NOW }], NOW);
    expect(m.strength).toBeCloseTo(0.25, 10);
    expect(m.mastered).toBe(false);
    expect(m.everCorrectCount).toBe(1);
  });

  it('is fully mastered when every scenario was just answered', () => {
    const outcomes = ids.map((id) => ({ scenarioId: id, lastCorrectAt: NOW }));
    const m = packageMastery(level, ids, outcomes, NOW);
    expect(m.strength).toBe(1);
    expect(m.mastered).toBe(true);
    expect(m.freshCount).toBe(4);
  });

  it('lapses out of mastery as time passes without practice', () => {
    const outcomes = ids.map((id) => ({ scenarioId: id, lastCorrectAt: NOW }));
    const fresh = packageMastery(level, ids, outcomes, NOW);
    expect(fresh.mastered).toBe(true);

    // The whole point of the decision: the same answers, later, are not mastery.
    const later = packageMastery(level, ids, outcomes, NOW + 60 * DAY);
    expect(later.mastered).toBe(false);
    expect(later.strength).toBeLessThan(fresh.strength);
    expect(later.everCorrectCount).toBe(4); // still "ever correct" — only strength decayed
  });

  it('keeps the most recent answer when a scenario appears more than once', () => {
    const outcomes = [
      { scenarioId: sid('a'), lastCorrectAt: ago(200) },
      { scenarioId: sid('a'), lastCorrectAt: NOW },
    ];
    const m = packageMastery(level, [sid('a')], outcomes, NOW);
    expect(m.strength).toBe(1);
  });

  it('ignores outcomes for scenarios outside the package', () => {
    const m = packageMastery(
      level,
      [sid('a')],
      [{ scenarioId: sid('zzz'), lastCorrectAt: NOW }],
      NOW,
    );
    expect(m.strength).toBe(0);
    expect(m.everCorrectCount).toBe(0);
  });

  it('counts a scenario as fresh only within one half-life', () => {
    const justInside = packageMastery(
      level,
      [sid('a')],
      [{ scenarioId: sid('a'), lastCorrectAt: ago(MASTERY_HALF_LIFE_DAYS - 1) }],
      NOW,
    );
    const justOutside = packageMastery(
      level,
      [sid('a')],
      [{ scenarioId: sid('a'), lastCorrectAt: ago(MASTERY_HALF_LIFE_DAYS + 1) }],
      NOW,
    );
    expect(justInside.freshCount).toBe(1);
    expect(justOutside.freshCount).toBe(0);
  });

  it('mastered is exactly strength >= MASTERED_THRESHOLD', () => {
    const outcomes = ids.map((id) => ({ scenarioId: id, lastCorrectAt: NOW }));
    // Find a moment where strength sits just each side of the threshold.
    const halfLifeMs = MASTERY_HALF_LIFE_DAYS * DAY;
    const atThreshold = NOW + Math.log2(1 / MASTERED_THRESHOLD) * halfLifeMs;
    expect(packageMastery(level, ids, outcomes, atThreshold - 1000).mastered).toBe(true);
    expect(packageMastery(level, ids, outcomes, atThreshold + 1000).mastered).toBe(false);
  });
});

describe('overallMastery', () => {
  const mk = (level: number, strength: number, total: number) => ({
    level: level as Level,
    strength,
    mastered: strength >= MASTERED_THRESHOLD,
    freshCount: 0,
    everCorrectCount: 0,
    total,
  });

  it('is 0 with no scenarios — never NaN', () => {
    const o = overallMastery([]);
    expect(o.strength).toBe(0);
    expect(Number.isNaN(o.strength)).toBe(false);
  });

  it('weights by package size, so small packages cannot be farmed', () => {
    // Player A knows a 20-situation package perfectly and nothing else.
    const a = overallMastery([mk(9, 1, 20), mk(1, 0, 9)]);
    // Player B knows the 9-situation package perfectly and nothing else.
    const b = overallMastery([mk(9, 0, 20), mk(1, 1, 9)]);
    // A knows strictly more situations, so A must rank higher. An unweighted
    // mean would tie them at 0.5.
    expect(a.strength).toBeGreaterThan(b.strength);
    expect(a.strength).toBeCloseTo(20 / 29, 10);
    expect(b.strength).toBeCloseTo(9 / 29, 10);
  });

  it('equals the mean strength across every situation', () => {
    const packages = [mk(1, 0.5, 10), mk(2, 1, 10)];
    expect(overallMastery(packages).strength).toBeCloseTo(0.75, 10);
  });

  it('counts mastered packages independently of overall strength', () => {
    const o = overallMastery([mk(1, 1, 10), mk(2, 0.1, 10)]);
    expect(o.masteredCount).toBe(1);
    expect(o.totalScenarios).toBe(20);
  });
});
