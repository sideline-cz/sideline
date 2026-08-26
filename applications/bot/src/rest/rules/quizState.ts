/**
 * The Discord rules quiz is **stateless** — a participant's progress through
 * a chain lives entirely in the `custom_id` of the buttons they are looking
 * at, and nowhere else.
 *
 * That is a deliberate choice, not a shortcut. The alternatives all cost
 * something this feature should not pay:
 *
 * - An in-memory `Map` in the bot loses every in-flight chain on restart,
 *   and the bot restarts on every deploy.
 * - A server-side session table needs a migration, a repository, a cleanup
 *   sweep for abandoned chains, and an RPC round trip per button press.
 *
 * It fits comfortably: scenario ids are ≤3 characters (`s1`, `pl9`, `gm1`),
 * chains are at most 5 steps, and options are at most 4 per step — so the
 * longest possible id is `rules-step:xxx:01234`, 20 characters against
 * Discord's 100-character `custom_id` limit.
 *
 * **Picks are ORIGINAL option indices, never display positions** (decision
 * D5 in `docs/plans/rules-trainer.md`). The display order is a permutation
 * re-derived deterministically per (scenario, user) — see `perms.ts` — so
 * nothing about the shuffle needs storing either.
 */
import type { Answer, Level, RunState, Scenario, ScenarioId } from '@sideline/rules';
import { answerStep, blankAnswer } from '@sideline/rules';

export const QUIZ_START_PREFIX = 'rules-start:';
export const QUIZ_STEP_PREFIX = 'rules-step:';

/** Chains are at most 5 steps and options at most 4 per step, so every pick
 * is a single digit `0`–`3` and a full chain is at most 5 characters. */
const PICKS_PATTERN = /^[0-3]{0,5}$/;

export interface QuizStepId {
  readonly scenarioId: string;
  /** ORIGINAL option indices, in chain order. */
  readonly picks: readonly number[];
}

export function encodeStepId(scenarioId: string, picks: readonly number[]): string {
  return `${QUIZ_STEP_PREFIX}${scenarioId}:${picks.join('')}`;
}

export function encodeStartId(scenarioId: string): string {
  return `${QUIZ_START_PREFIX}${scenarioId}`;
}

/**
 * Parses a `rules-step:` id back into a scenario and its picks.
 *
 * Returns `undefined` rather than throwing for anything malformed. A
 * `custom_id` arrives from Discord and is echoed from a message the bot
 * wrote, but it is still untrusted input — a user can craft an interaction
 * with an arbitrary id, and this must not be a way to crash the handler.
 * Out-of-range picks are additionally rejected by `replayAnswer` below,
 * which relies on the engine's own guards rather than re-implementing them.
 */
export function decodeStepId(customId: string): QuizStepId | undefined {
  if (!customId.startsWith(QUIZ_STEP_PREFIX)) return undefined;
  const rest = customId.slice(QUIZ_STEP_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return undefined;
  const scenarioId = rest.slice(0, sep);
  const picksRaw = rest.slice(sep + 1);
  if (scenarioId.length === 0) return undefined;
  if (!PICKS_PATTERN.test(picksRaw)) return undefined;
  return { scenarioId, picks: [...picksRaw].map((c) => Number(c)) };
}

export function decodeStartId(customId: string): string | undefined {
  if (!customId.startsWith(QUIZ_START_PREFIX)) return undefined;
  const scenarioId = customId.slice(QUIZ_START_PREFIX.length);
  return scenarioId.length > 0 ? scenarioId : undefined;
}

/** A minimal `RunState` — `answerStep` reads only `answers[scenario.id]`
 * and `scenario.steps`; the rest of the shape is required by the type but
 * never consulted on this path. */
function runStateFor(scenario: Scenario, answers: Readonly<Record<ScenarioId, Answer>>): RunState {
  return {
    lang: 'en',
    mode: 'learn',
    current: scenario.id,
    sel: [] as readonly Level[],
    answers,
    perms: {},
    exam: null,
    reviewQ: 0,
  };
}

/**
 * Rebuilds the `Answer` for a chain from its picks by **replaying
 * `answerStep`**, rather than constructing the `Answer` directly.
 *
 * Replaying is what guarantees Discord scores a chain identically to web:
 * the "only the final step marks the answer done", "`ok` is every step
 * correct", and "ignore a pick that does not resolve to an option of the
 * current step" rules all live in the engine, and are not restated here. A
 * pick that the engine refuses (out of range, or past the end of the chain)
 * leaves the answer untouched, so a tampered `custom_id` degrades to a
 * shorter chain rather than a wrong verdict or a throw.
 */
export function replayAnswer(scenario: Scenario, picks: readonly number[]): Answer {
  let answers: Readonly<Record<ScenarioId, Answer>> = {};
  for (const pick of picks) {
    answers = answerStep(runStateFor(scenario, answers), scenario, pick).answers;
  }
  return answers[scenario.id] ?? blankAnswer();
}
