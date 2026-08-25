/**
 * `pool` / `poolLen` / `posOf` / `countLevel` — a practice run covers only
 * the selected packages (levels). The pool is always a list of
 * `ScenarioId`s, never array indices (Phase 0 plan, decision D8); authored
 * order is preserved so `posOf` matches what a user actually sees.
 */
import type { Level, Scenario, ScenarioId } from '../types.js';

export function pool(scenarios: readonly Scenario[], sel: readonly Level[]): ScenarioId[] {
  return scenarios.filter((sc) => sel.includes(sc.level)).map((sc) => sc.id);
}

export function poolLen(scenarios: readonly Scenario[], sel: readonly Level[]): number {
  return pool(scenarios, sel).length;
}

/** 1-indexed position of `id` within the current pool, or `0` if it is not
 * in the pool (ported from the source's `posOf`, whose `indexOf(...) + 1`
 * gives the same "0 means absent" convention for free). */
export function posOf(
  scenarios: readonly Scenario[],
  sel: readonly Level[],
  id: ScenarioId,
): number {
  return pool(scenarios, sel).indexOf(id) + 1;
}

export function countLevel(scenarios: readonly Scenario[], level: Level): number {
  return scenarios.filter((sc) => sc.level === level).length;
}
