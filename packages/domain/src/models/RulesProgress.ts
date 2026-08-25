/**
 * Rows for the Rules Trainer's per-user progress (`rules_attempts` +
 * `rules_scenario_results`) — see `docs/plans/rules-trainer.md` Phase 2 and
 * `packages/rules/src/engine/mastery.ts`.
 *
 * This module intentionally does NOT import `@sideline/rules`: `ScenarioId`
 * there is a plain TS brand from a non-Effect package (no `Schema`), and
 * `Level` is a plain `1 | 2 | ... | 9` union — neither needs an Effect
 * schema to cross this boundary, so `scenario_id` decodes as `Schema.String`
 * and package levels decode as the local `Level` schema below. Keeping the
 * two packages decoupled means `@sideline/rules` (browser + Node, zero I/O)
 * never has to know about `@sideline/domain`'s wire/HTTP concerns.
 *
 * `RulesPackageMastery` / `RulesOverallMastery` mirror `PackageMastery` /
 * the return type of `overallMastery` in `@sideline/rules`'s
 * `engine/mastery.ts` field-for-field so the server (follow-up PR) can map
 * the pure computation onto the wire DTO 1:1, with no renaming in between.
 */
import { Schema } from 'effect';
import { UserId } from '~/models/User.js';

export const RulesAttemptId = Schema.String.pipe(Schema.brand('RulesAttemptId'));
export type RulesAttemptId = typeof RulesAttemptId.Type;

export const RulesAttemptMode = Schema.Literals(['practice', 'exam']);
export type RulesAttemptMode = typeof RulesAttemptMode.Type;

/** A rules package level, `1`–`9` — mirrors `Level` in `@sideline/rules`'s `types.ts`. */
export const Level = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 9 })));
export type Level = typeof Level.Type;

/**
 * One chain step's picked option and whether it was correct. Mirrors
 * `StepPick` in `@sideline/rules`'s `engine/state.ts`
 * (`{ pick: number | null, ok: boolean }`) — `pick` is the original option
 * index, or absent when the client-supplied pick could not be trusted (see
 * `engine/score.ts`'s `scoreAttempt`).
 */
export class RulesStepPick extends Schema.Class<RulesStepPick>('RulesStepPick')({
  pick: Schema.OptionFromNullOr(Schema.Int),
  ok: Schema.Boolean,
}) {}

/** One scenario's stored result within an attempt — matches `rules_scenario_results`. */
export class RulesScenarioResult extends Schema.Class<RulesScenarioResult>('RulesScenarioResult')({
  attempt_id: RulesAttemptId,
  scenario_id: Schema.String,
  correct: Schema.Boolean,
  steps: Schema.Array(RulesStepPick),
}) {}

/**
 * A submitted attempt row — matches `rules_attempts`. `score`/`total` are
 * always computed server-side by `scoreAttempt` from `@sideline/rules`
 * (Phase 2 follow-up); this schema never accepts them as client input (see
 * `api/RulesTrainerApi.ts`'s `SubmitAttemptRequest`, which omits both).
 */
export class RulesAttempt extends Schema.Class<RulesAttempt>('RulesAttempt')({
  id: RulesAttemptId,
  user_id: UserId,
  mode: RulesAttemptMode,
  packages: Schema.Array(Level),
  started_at: Schema.String,
  finished_at: Schema.OptionFromNullOr(Schema.String),
  score: Schema.Int,
  total: Schema.Int,
  created_at: Schema.String,
}) {}

/** Mirrors `PackageMastery` in `@sideline/rules`'s `engine/mastery.ts`. */
export class RulesPackageMastery extends Schema.Class<RulesPackageMastery>('RulesPackageMastery')({
  level: Level,
  /** Mean scenario strength in `[0, 1]`. */
  strength: Schema.Number,
  /** `strength >= MASTERED_THRESHOLD` (see `@sideline/rules`). */
  mastered: Schema.Boolean,
  /** Scenarios whose strength is still at least half — within one half-life. */
  freshCount: Schema.Int,
  /** Scenarios ever answered correctly, however long ago. */
  everCorrectCount: Schema.Int,
  /** Scenarios in the package. `0` means the package is empty, not mastered. */
  total: Schema.Int,
}) {}

/** Mirrors the return type of `overallMastery` in `@sideline/rules`'s `engine/mastery.ts`. */
export class RulesOverallMastery extends Schema.Class<RulesOverallMastery>('RulesOverallMastery')({
  strength: Schema.Number,
  masteredCount: Schema.Int,
  totalScenarios: Schema.Int,
}) {}

/** `GET /rules/progress` (`myProgress`) response body. */
export class RulesMasterySummary extends Schema.Class<RulesMasterySummary>('RulesMasterySummary')({
  packages: Schema.Array(RulesPackageMastery),
  overall: RulesOverallMastery,
}) {}
