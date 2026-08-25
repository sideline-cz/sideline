/**
 * `shuffle` / `buildPerms` / `buildRunPerms` — correct options are authored
 * first, so practice must shuffle display order or every answer would be
 * "A" (Phase 0 plan, decisions D4/D5). Unlike the source's `permsFor`, which
 * lazily memoized into `state.perms[i]` on first read (a read that writes),
 * `buildPerms` runs eagerly, once per run, and its result is stored verbatim
 * on `RunState.perms` / `ExamState.perms`.
 */
import type { Level, Scenario, ScenarioId } from '../types.js';
import { pool } from './pool.js';

/**
 * Fisher-Yates, ported from the source verbatim except it does not mutate
 * `xs` — it copies first. `rng` defaults to `Math.random`; tests inject a
 * deterministic stub so exam/perms output is reproducible.
 */
export function shuffle<T>(xs: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** One shuffled permutation of `0..opts.length-1` per step of the chain. */
export function buildPerms(scenario: Scenario, rng: () => number = Math.random): number[][] {
  return scenario.steps.map((st) =>
    shuffle(
      st.opts.map((_, j) => j),
      rng,
    ),
  );
}

/**
 * The producer for `RunState.perms` — the learn-mode counterpart of what
 * `startExam` already does for `ExamState.perms`. Without this, nothing
 * ever populated `RunState.perms`, so `chainView` had no real permutation
 * to relay for the learn flow and every option rendered in authored order
 * (the correct one always first). One `buildPerms` result per scenario
 * currently in the pool (`pool(scenarios, sel)`); a scenario outside the
 * pool gets no entry at all, matching `RunState.answers`' own "absent means
 * not started" convention.
 */
export function buildRunPerms(
  scenarios: readonly Scenario[],
  sel: readonly Level[],
  rng: () => number = Math.random,
): Readonly<Record<ScenarioId, readonly (readonly number[])[]>> {
  const byId = new Map(scenarios.map((sc) => [sc.id, sc] as const));
  const perms: Record<ScenarioId, readonly (readonly number[])[]> = {};
  for (const id of pool(scenarios, sel)) {
    const sc = byId.get(id);
    if (sc) perms[id] = buildPerms(sc, rng);
  }
  return perms;
}
