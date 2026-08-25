/**
 * Engine state shapes (Phase 0 plan, "Engine port"). Every function in
 * `app.js` was argument-less and closed over a module-global `state`; the
 * port makes that state explicit and immutable — every transition in
 * `engine/answer.ts` returns a new `RunState`, never mutates one.
 *
 * State is keyed by `ScenarioId`, never by array index (decision D8):
 * inserting a scenario into a package must never silently shift a stored
 * user's answers onto the wrong scenario.
 */
import type { Lang, Level, Scenario, ScenarioId, Team } from '../types.js';

export type Mode = 'learn' | 'exam' | 'examResults' | 'review';

/**
 * `pick` is the ORIGINAL option index (never a shuffled display position —
 * see decision D5), or `null` — the one documented sentinel for "the
 * client-supplied pick could not be trusted": wrong type, non-integer,
 * out of range, or (via `scoreAttempt`) a `picks` array of the wrong length
 * entirely. `answerStep` / `examAnswer` never produce `null` — they only
 * ever append a `StepPick` once the pick has already resolved to a real
 * option (see `engine/answer.ts`); only `scoreAttempt` (`engine/score.ts`)
 * produces it, for exactly the reason described there. `null`, not `-1`:
 * `-1` was a distinct, now-dropped timed-out sentinel (see `AGENTS.md`) and
 * reusing it here for an unrelated meaning would be confusing.
 */
export type StepPick = { readonly pick: number | null; readonly ok: boolean };

export type Answer = {
  readonly steps: readonly StepPick[];
  readonly done: boolean;
  readonly ok: boolean;
};

export type ExamState = {
  readonly qs: readonly ScenarioId[];
  readonly perms: readonly (readonly (readonly number[])[])[];
  readonly answers: readonly Answer[];
  readonly i: number;
};

export type RunState = {
  readonly lang: Lang;
  readonly mode: Mode;
  readonly current: ScenarioId;
  readonly sel: readonly Level[];
  readonly answers: Readonly<Record<ScenarioId, Answer>>;
  readonly perms: Readonly<Record<ScenarioId, readonly (readonly number[])[]>>;
  readonly exam: ExamState | null;
  readonly reviewQ: number;
};

export function blankAnswer(): Answer {
  return { steps: [], done: false, ok: false };
}

/** The chain of steps authored for a scenario. Ported from the source's
 * `stepsOf`, which read a side `STEPS` map keyed by scenario id — chains now
 * live inline on the scenario (decision D7), so this is just the field
 * accessor, kept as a named export because callers throughout the plan
 * reference `stepsOf(sc)`, not `sc.steps`. */
export function stepsOf(scenario: Scenario): readonly Scenario['steps'][number][] {
  return scenario.steps;
}

/** The team of the actor with the given id, or `'off'` if no such actor
 * exists on the scenario (ported verbatim from the source's `actorTeam`). */
export function actorTeam(scenario: Scenario, id: string): Team {
  const actor = scenario.actors.find((a) => a.id === id);
  return actor ? actor.team : 'off';
}

/**
 * The answer currently on screen, branching on mode exactly like the
 * source's `currentAnswer`:
 *  - `review`: the exam answer at `reviewQ` (or `null` if there is no exam)
 *  - `exam`: always `null` — the exam's live answer is read off `exam.answers[exam.i]` by the caller
 *  - otherwise (`learn`): the run's answer for the current scenario, or blank
 */
export function currentAnswer(state: RunState): Answer | null {
  if (state.mode === 'review') {
    return state.exam ? (state.exam.answers[state.reviewQ] ?? null) : null;
  }
  if (state.mode === 'exam') {
    return null;
  }
  return state.answers[state.current] ?? blankAnswer();
}
