/**
 * `chainView` — the spoiler gate, half B (see `anim.ts` for half A). Pure
 * extraction of the decision logic behind the source's `chainHTML` (Phase 0
 * plan, decision D9): which steps are visible, whether a verdict/key label
 * may be shown, and in what order the options display.
 *
 * Two regressions this exists to prevent forever:
 *  - a locked step leaking its key label (the dimension name can itself be
 *    a spoiler — e.g. "Where it restarts" implies there IS a restart)
 *  - the exam rendering more than the single live step, or leaking a verdict
 *
 * `chainView` never shuffles anything itself — it only relays whatever
 * permutation the caller supplies. The caller MUST pass the run's actual
 * perms (`RunState.perms[scenario.id]` for learn, built by
 * `buildRunPerms`; `ExamState.perms[i]` for exam/review, built by
 * `startExam`) or every option renders in its authored order, which is
 * always "the correct one first" (decisions D4/D5) — the exact defect
 * `buildPerms`/`shuffle` exist to prevent. Omitting `perms` (or a step
 * missing from it) falls back to the identity order rather than throwing,
 * so a caller that has not wired perms yet still renders something.
 */
import type { Scenario } from '../types.js';
import type { Answer, Mode } from './state.js';
import { stepsOf } from './state.js';

export type ChainStepState = 'answered' | 'current' | 'locked' | 'hidden';

export type ChainEntry = {
  readonly index: number;
  readonly state: ChainStepState;
  readonly showVerdict: boolean;
  readonly showKeyLabel: boolean;
  /** Display position → original option index. Identity (`[0, 1, 2, …]`)
   * unless the caller's `perms[index]` supplies a real permutation — see
   * the module doc above. */
  readonly order: readonly number[];
};

/**
 * Per step of the chain: whether it is answered, the live (current) one, a
 * locked placeholder, or — in `exam` mode, where only the live step is ever
 * on screen — hidden entirely. A dimension's key label (`step.k`) is shown
 * only on its first occurrence among the steps actually rendered (never on
 * a locked step, which must never leak it), mirroring the source's `seen`
 * bookkeeping in `labelFor`. `perms[i]`, if supplied, is relayed verbatim as
 * `order` for step `i` — see the module doc for who is responsible for
 * building it.
 */
export function chainView(
  scenario: Scenario,
  answer: Answer,
  mode: Mode,
  perms?: readonly (readonly number[])[],
): ChainEntry[] {
  const steps = stepsOf(scenario);
  const n = steps.length;
  const cur = answer.steps.length;
  const blind = mode === 'exam';
  const liveIdx = Math.min(cur, Math.max(n - 1, 0));
  const seen = new Set<string>();

  return steps.map((st, i) => {
    const order = perms?.[i] ?? st.opts.map((_, j) => j);
    const answered = i < cur;
    const isCur = i === cur && !answer.done;

    if (blind && i !== liveIdx) {
      return { index: i, state: 'hidden' as const, showVerdict: false, showKeyLabel: false, order };
    }

    if (!answered && !isCur) {
      // No key label here on purpose — e.g. "Where it restarts" would
      // already tell you there IS a restart before you have answered what
      // happens.
      return { index: i, state: 'locked' as const, showVerdict: false, showKeyLabel: false, order };
    }

    const first = !seen.has(st.k);
    if (first) seen.add(st.k);

    const state: ChainStepState = answered ? 'answered' : 'current';
    return {
      index: i,
      state,
      showVerdict: answered && !blind,
      showKeyLabel: first,
      order,
    };
  });
}
