/**
 * HTTP API for the Rules Trainer's per-user progress (Phase 2 of
 * `docs/plans/rules-trainer.md`). HTTP, not RPC, because this is a
 * web-facing feature — RPC groups in this package are bot-only.
 *
 * Both endpoints are caller-scoped: there is no team parameter and no
 * cross-user lookup, so (like `ICalApiGroup`'s `/me/ical-token`) neither
 * endpoint declares a custom error beyond what `AuthMiddleware` already
 * provides (401 on missing/invalid token). `myProgress` is named per
 * "Caller-Scoped Reads" (`applications/server/AGENTS.md`) — the query is
 * always scoped to the authenticated user, never to a caller-supplied id.
 */
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import {
  Level,
  RulesAttempt,
  RulesAttemptMode,
  RulesMasterySummary,
} from '~/models/RulesProgress.js';

/**
 * One scenario's raw submitted picks, prior to server-side scoring. `steps[i]`
 * is the ORIGINAL option index the client chose for the scenario's `i`-th
 * chain step (never a shuffled display position), or absent when the step
 * was left unanswered. The follow-up server handler runs these through
 * `scoreAttempt` from `@sideline/rules` to derive the stored `correct` /
 * `steps` (`RulesStepPick[]`) columns and the attempt's `score`/`total` — see
 * `packages/rules/src/engine/score.ts`.
 */
export const SubmitAttemptResultInput = Schema.Struct({
  scenario_id: Schema.String,
  steps: Schema.Array(Schema.OptionFromNullOr(Schema.Int)),
});
export type SubmitAttemptResultInput = Schema.Schema.Type<typeof SubmitAttemptResultInput>;

export const SubmitAttemptRequest = Schema.Struct({
  mode: RulesAttemptMode,
  packages: Schema.Array(Level),
  results: Schema.Array(SubmitAttemptResultInput),
});
export type SubmitAttemptRequest = Schema.Schema.Type<typeof SubmitAttemptRequest>;

export class RulesTrainerApiGroup extends HttpApiGroup.make('rulesTrainer')
  .add(
    HttpApiEndpoint.post('submitAttempt', '/rules/attempts', {
      success: RulesAttempt.pipe(HttpApiSchema.status(201)),
      payload: SubmitAttemptRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('myProgress', '/rules/progress', {
      success: RulesMasterySummary,
    }).middleware(AuthMiddleware),
  ) {}
