/**
 * `score` / `answeredCount` / `examScore` — counts that only ever consider
 * the current pool (a scenario whose level was deselected mid-run must not
 * count either way) or the current exam. `scoreAttempt` is the honour-system
 * scoring primitive.
 *
 * `scoreAttempt` is shared scoring logic, **not a trust boundary**: Phase 1
 * ships the full answer key to the device so the offline PWA works without
 * signal, so any exam key is already local, and the leaderboard is an
 * accepted honour system. `ok: true` sits at index 0 in all 367 steps and
 * the `ok` flags ship to the client for offline practice, so a client
 * submitting `[0, 0, 0, …]` scores 100% — that is expected, not a defect.
 *
 * What `scoreAttempt` *does* guard is malformed input, and it must never
 * throw doing so — a Phase 2 RPC handler may well reach this before a
 * schema decode. `picks` may not even be an array (`null`/`undefined`/a
 * client typo), may be the wrong length, or any individual entry may be the
 * wrong type, non-integer, out of range, `NaN`, `Infinity`, or a `bigint`.
 * None of that is indexed into `opts` blindly, none of it throws, and none
 * of it is echoed back verbatim into the (JSON-serializable,
 * `localStorage`-round-tripped) `Answer` this returns — every untrustworthy
 * pick normalises to the one documented sentinel, `null` (see `StepPick` in
 * `state.ts`), never scored as correct.
 */
import type { Scenario, Step } from '../types.js';
import { pool } from './pool.js';
import type { Answer, RunState, StepPick } from './state.js';

export function score(state: RunState, scenarios: readonly Scenario[]): number {
  return pool(scenarios, state.sel).filter((id) => {
    const a = state.answers[id];
    return a?.done && a.ok;
  }).length;
}

export function answeredCount(state: RunState, scenarios: readonly Scenario[]): number {
  return pool(scenarios, state.sel).filter((id) => state.answers[id]?.done).length;
}

export function examScore(state: RunState): number {
  return state.exam ? state.exam.answers.filter((a) => a.ok).length : 0;
}

/** `pick` is `unknown`, not `number`, on purpose — it may be arbitrary
 * client-supplied JSON that has not gone through a schema decode yet. */
function isValidPick(pick: unknown, optCount: number): pick is number {
  return typeof pick === 'number' && Number.isInteger(pick) && pick >= 0 && pick < optCount;
}

/**
 * Scores a full attempt at a chain, `picks[i]` being the ORIGINAL option
 * index chosen for `chain[i]` (never a shuffled display position — decision
 * D5). Order-independent: permuting `chain` and `picks` together in lock
 * step yields the same per-step verdicts (as a multiset) and the same
 * overall `ok`.
 *
 * A `picks` that is not an array, or whose length does not match `chain`,
 * scores every step as an untrusted (`pick: null`), incorrect pick rather
 * than tolerating a too-long array or throwing on a missing one.
 */
export function scoreAttempt(chain: readonly Step[], picks: readonly number[]): Answer {
  if (!Array.isArray(picks) || picks.length !== chain.length) {
    return { steps: chain.map(() => ({ pick: null, ok: false })), done: true, ok: false };
  }
  const steps: StepPick[] = chain.map((st, i) => {
    const raw: unknown = picks[i];
    const pick = isValidPick(raw, st.opts.length) ? raw : null;
    return { pick, ok: pick !== null && st.opts[pick]?.ok === true };
  });
  return {
    steps,
    done: true,
    ok: steps.every((s) => s.ok),
  };
}
