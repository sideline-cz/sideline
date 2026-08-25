/**
 * Decaying mastery — how well a player currently knows a package.
 *
 * `docs/plans/rules-trainer.md` left "what counts as mastering a package?" open
 * and named it a blocker on Phase 2's schema, because it defines what the
 * leaderboard ranks. Decided: **mastery decays**. Getting a situation right in
 * March should not still read as mastery in September; rules knowledge fades,
 * and a measure that never fades rewards a single burst of practice forever.
 *
 * This lives in `@sideline/rules`, not the server, for the reason the package
 * exists: it is pure logic that three consumers need to agree on. The server
 * ranks a leaderboard with it, web renders a progress panel with it, and a
 * Discord bot would answer "how am I doing?" with it. One definition, one set
 * of tests, no drift.
 *
 * ## Why exponential, and why computed on read
 *
 * Exponential half-life decay, not linear: it is the standard spaced-repetition
 * shape, it never quite reaches zero (so a situation you once knew never counts
 * as *never* known, which is both kinder and truer), and it needs only one
 * stored timestamp per scenario rather than a history.
 *
 * That last property is what keeps Phase 2's schema small: strength is derived
 * from `lastCorrectAt` at read time. There is no materialised score to keep
 * fresh, so no cron job, no staleness window, and no risk of a leaderboard
 * disagreeing with a progress panel because one was recomputed and the other
 * was not. At club scale the arithmetic is free.
 */

import type { Level, ScenarioId } from '../types.js';

/**
 * Days for a correct answer to decay to half strength.
 *
 * 45 days is a judgement, not a derivation, and it is a constant so it can be
 * argued with. The reasoning: an ultimate season runs in blocks of tournaments
 * a few weeks apart, so a player who practises before one tournament and not
 * the next should visibly slip rather than stay green. At 45 days, three months
 * of neglect lands near a quarter strength — clearly lapsed, not erased.
 */
export const MASTERY_HALF_LIFE_DAYS = 45;

/**
 * Mean scenario strength at which a package counts as mastered.
 *
 * Deliberately below 1: requiring every situation to be simultaneously fresh
 * would make mastery almost unreachable for the 20-situation package and would
 * flicker off the moment one situation aged. 0.8 means "you know nearly all of
 * this, recently".
 */
export const MASTERED_THRESHOLD = 0.8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** When a player last answered a scenario's whole chain correctly. */
export type ScenarioOutcome = {
  readonly scenarioId: ScenarioId;
  /** Epoch milliseconds, or `null` for "never answered correctly". */
  readonly lastCorrectAt: number | null;
};

/** A package's current mastery, and the parts it was derived from. */
export type PackageMastery = {
  readonly level: Level;
  /** Mean scenario strength in `[0, 1]`. */
  readonly strength: number;
  /** `strength >= MASTERED_THRESHOLD`. */
  readonly mastered: boolean;
  /** Scenarios whose strength is still at least half — i.e. within one half-life. */
  readonly freshCount: number;
  /** Scenarios ever answered correctly, however long ago. */
  readonly everCorrectCount: number;
  /** Scenarios in the package. `0` means the package is empty, not mastered. */
  readonly total: number;
};

/**
 * Strength of a single scenario in `[0, 1]`.
 *
 * Never correct → `0`. Just answered → `1`. One half-life ago → `0.5`.
 *
 * A `lastCorrectAt` in the future clamps to `1` rather than exceeding it:
 * client clocks are wrong all the time, and a device an hour fast must not be
 * able to report strength above full. Non-finite input is treated as "never".
 */
export function scenarioStrength(
  lastCorrectAt: number | null,
  now: number,
  halfLifeDays: number = MASTERY_HALF_LIFE_DAYS,
): number {
  if (lastCorrectAt === null || !Number.isFinite(lastCorrectAt)) return 0;
  if (!Number.isFinite(now)) return 0;
  // A non-positive half-life would divide by zero or invert the curve; treat it
  // as "decays instantly", which is the closest sane reading.
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return lastCorrectAt >= now ? 1 : 0;

  const elapsedDays = (now - lastCorrectAt) / MS_PER_DAY;
  if (elapsedDays <= 0) return 1;
  return 2 ** (-elapsedDays / halfLifeDays);
}

/**
 * Mastery of one package.
 *
 * `scenarioIds` is the package's full roster — passing only the scenarios a
 * player has touched would make mastery trivially reachable by practising one
 * situation, so unanswered scenarios must be present and contribute `0`.
 *
 * An empty package yields `strength: 0, mastered: false`, never `NaN`: the mean
 * of no scenarios is not 1, and a `NaN` here would propagate silently into a
 * leaderboard ordering.
 */
export function packageMastery(
  level: Level,
  scenarioIds: readonly ScenarioId[],
  outcomes: readonly ScenarioOutcome[],
  now: number,
  halfLifeDays: number = MASTERY_HALF_LIFE_DAYS,
): PackageMastery {
  const total = scenarioIds.length;
  if (total === 0) {
    return {
      level,
      strength: 0,
      mastered: false,
      freshCount: 0,
      everCorrectCount: 0,
      total: 0,
    };
  }

  // Last-correct-wins if a caller passes duplicates for the same scenario: the
  // most recent correct answer is the one that matters.
  const lastCorrect = new Map<ScenarioId, number>();
  for (const outcome of outcomes) {
    if (outcome.lastCorrectAt === null || !Number.isFinite(outcome.lastCorrectAt)) continue;
    const existing = lastCorrect.get(outcome.scenarioId);
    if (existing === undefined || outcome.lastCorrectAt > existing) {
      lastCorrect.set(outcome.scenarioId, outcome.lastCorrectAt);
    }
  }

  let sum = 0;
  let freshCount = 0;
  let everCorrectCount = 0;
  for (const id of scenarioIds) {
    const at = lastCorrect.get(id) ?? null;
    if (at !== null) everCorrectCount++;
    const strength = scenarioStrength(at, now, halfLifeDays);
    sum += strength;
    if (strength >= 0.5) freshCount++;
  }

  const strength = sum / total;
  return {
    level,
    strength,
    mastered: strength >= MASTERED_THRESHOLD,
    freshCount,
    everCorrectCount,
    total,
  };
}

/**
 * Overall mastery across packages — the number a leaderboard ranks on.
 *
 * The mean of per-package strengths **weighted by package size**, not a plain
 * mean of the nine: an unweighted mean would make the 9-situation packages
 * count the same as the 20-situation one, so a player could out-rank someone
 * who knows strictly more situations by concentrating on the small packages.
 * Weighting by `total` makes this identical to "mean strength across every
 * situation", which is the thing players would assume it means.
 */
export function overallMastery(packages: readonly PackageMastery[]): {
  readonly strength: number;
  readonly masteredCount: number;
  readonly totalScenarios: number;
} {
  const totalScenarios = packages.reduce((n, p) => n + p.total, 0);
  const masteredCount = packages.filter((p) => p.mastered).length;
  if (totalScenarios === 0) return { strength: 0, masteredCount, totalScenarios: 0 };

  const weighted = packages.reduce((sum, p) => sum + p.strength * p.total, 0);
  return { strength: weighted / totalScenarios, masteredCount, totalScenarios };
}
