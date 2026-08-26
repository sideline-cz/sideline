/**
 * The per-participant option shuffle for the Discord quiz.
 *
 * **This is load-bearing, not cosmetic.** `ok: true` sits at option index 0
 * in all 367 authored steps (decisions D4/D5 in
 * `docs/plans/rules-trainer.md`), so rendering options in authored order
 * would make "A" the correct answer every single time.
 *
 * Web builds its permutation once per run and keeps it on `RunState.perms`.
 * Discord has nowhere to keep it — the quiz is stateless (see
 * `quizState.ts`) — so instead of storing the permutation it is **re-derived
 * deterministically** from `(scenarioId, userId)`. Same participant, same
 * scenario, same order on every button press; a different participant gets a
 * different order, so answers cannot be copied from a neighbour's screen.
 *
 * `buildPerms` already accepts an injected `rng` (its tests use it), so this
 * needs no change to `@sideline/rules` — it only supplies a different source
 * of randomness to the same function web uses.
 */
import type { Scenario } from '@sideline/rules';
import { buildPerms } from '@sideline/rules';

/**
 * FNV-1a, 32-bit. Chosen for being short, dependency-free and well-spread
 * over short ASCII keys — this seeds a display shuffle, so it needs
 * avalanche, not cryptographic strength.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a small, well-distributed seeded PRNG returning `[0, 1)`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The display order for every step of `scenario`, stable for this
 * participant. `perms[i][displayPosition]` is the ORIGINAL option index —
 * exactly the shape `chainView` relays as `ChainEntry.order`.
 */
export function quizPerms(scenario: Scenario, userId: string): number[][] {
  return buildPerms(scenario, mulberry32(hash32(`${scenario.id}:${userId}`)));
}
