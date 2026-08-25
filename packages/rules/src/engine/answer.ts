/**
 * `answerStep` / `examAnswer` / `advanceExam` / `openReview` — the pure
 * state transitions behind the chain-answering flow (Phase 0 plan,
 * "Engine port": `engine/answer.ts`). All four guards from the source
 * (`a.done`, empty chain, `!st`, `!st.opts[pick]`) still hold. Unlike the
 * source, which mutated `state.answers[i]` / `ex.answers[ex.i]` in place,
 * none of these mutate their input `RunState` — each returns a new one.
 */
import type { Scenario } from '../types.js';
import type { Answer, Mode, RunState, StepPick } from './state.js';
import { blankAnswer } from './state.js';

function advanceChain(a: Answer, steps: Scenario['steps'], pick: number): Answer | null {
  if (a.done || steps.length === 0) return null;
  const si = a.steps.length;
  const st = steps[si];
  const opt = st?.opts[pick];
  if (!st || si >= steps.length || !opt) return null;
  const newSteps: StepPick[] = [...a.steps, { pick, ok: opt.ok === true }];
  const done = newSteps.length >= steps.length;
  const ok = done && newSteps.every((s) => s.ok);
  return { steps: newSteps, done, ok };
}

/**
 * Answer the current step of the current scenario's chain. Only the final
 * step marks the answer `done` — earlier steps just unlock the next
 * question, so the demo stays frozen at `qAt` while the chain is in
 * progress (see `animLimit`). Ignores the pick if the chain is already
 * done, the chain is empty, or the pick does not resolve to an option of
 * the current step.
 */
export function answerStep(state: RunState, scenario: Scenario, pick: number): RunState {
  const current = state.answers[scenario.id] ?? blankAnswer();
  const next = advanceChain(current, scenario.steps, pick);
  if (!next) return state;
  return { ...state, answers: { ...state.answers, [scenario.id]: next } };
}

/**
 * Answer the current step of the live exam question. No feedback is ever
 * shown in the exam — the demo stays frozen at `qAt` throughout, which is
 * `animLimit`'s job, not this function's.
 */
export function examAnswer(state: RunState, scenario: Scenario, pick: number): RunState {
  const ex = state.exam;
  if (!ex) return state;
  const current = ex.answers[ex.i] ?? blankAnswer();
  const next = advanceChain(current, scenario.steps, pick);
  if (!next) return state;
  const answers = ex.answers.map((a, idx) => (idx === ex.i ? next : a));
  return { ...state, exam: { ...ex, answers } };
}

/** Moves to the next exam question, or into `examResults` once every
 * question has been answered. */
export function advanceExam(state: RunState): RunState {
  const ex = state.exam;
  if (!ex) return state;
  const i = ex.i + 1;
  const mode: Mode = i >= ex.qs.length ? 'examResults' : 'exam';
  return { ...state, mode, exam: { ...ex, i } };
}

/** Opens the review view for exam question `k`. */
export function openReview(state: RunState, k: number): RunState {
  const ex = state.exam;
  if (!ex) return state;
  const current = ex.qs[k];
  if (current === undefined) return state;
  return { ...state, reviewQ: k, mode: 'review', current };
}
