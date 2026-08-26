/**
 * HTTP API for the Rules Trainer's per-user progress (Phase 2 of
 * `docs/plans/rules-trainer.md`) and team leaderboard (Phase 3a).
 * HTTP, not RPC, because this is a web-facing feature — RPC groups in this
 * package are bot-only.
 *
 * `submitAttempt` and `myProgress` are caller-scoped: there is no team
 * parameter and no cross-user lookup, so (like `ICalApiGroup`'s
 * `/me/ical-token`) neither endpoint declares a custom error beyond what
 * `AuthMiddleware` already provides (401 on missing/invalid token).
 * `myProgress` is named per "Caller-Scoped Reads"
 * (`applications/server/AGENTS.md`) — the query is always scoped to the
 * authenticated user, never to a caller-supplied id.
 *
 * `getRulesLeaderboard` is different: it is team-scoped (a `teamId` param,
 * per `getLeaderboard` in `LeaderboardApi.ts`), not caller-scoped, so it is
 * NOT named `my*` even though the plan decided visibility is "self and
 * captains only" (see `RulesLeaderboardResponse.scope` below) — the query
 * still ranks the whole team before filtering, it does not merely look up
 * the caller. Because it is team-scoped, non-membership must 403, so —
 * unlike the two caller-scoped endpoints above — it DOES declare a custom
 * error (`RulesLeaderboardForbidden`).
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
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { UserId } from '~/models/User.js';

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

/**
 * One team member's rank on the rules-trainer leaderboard. Mirrors
 * `LeaderboardApi.ts`'s `LeaderboardEntry` field-for-field where it can
 * (`rank`, `teamMemberId`, `userId`, `username`, `name`, `avatar`,
 * `displayName`) so the web UI (a future slice) can reuse the same
 * table/row components, plus the mastery numbers this leaderboard actually
 * ranks on (`strength`, `masteredCount`, `totalScenarios` — mirroring
 * `RulesOverallMastery` in `RulesProgress.ts`). Additive-friendly: the web
 * bundles a frozen copy of this schema, so new fields must be optional.
 */
export class RulesLeaderboardEntry extends Schema.Class<RulesLeaderboardEntry>(
  'RulesLeaderboardEntry',
)({
  rank: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  teamMemberId: TeamMemberId,
  userId: UserId,
  username: Schema.String,
  name: Schema.OptionFromOptional(Schema.String),
  avatar: Schema.OptionFromOptional(Schema.String),
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
  /** Mean scenario strength in `[0, 1]`, weighted by package size — see `@sideline/rules`'s `overallMastery`. */
  strength: Schema.Number,
  masteredCount: Schema.Int,
  totalScenarios: Schema.Int,
}) {}

/**
 * `scope: 'team'` — caller has `member:edit` (or is a global admin) and sees
 * every entry. `scope: 'self'` — caller is a plain member and `entries`
 * contains exactly their own entry, still carrying their TRUE team rank
 * (mastery is ranked over the whole team first, then filtered — never
 * ranked after filtering, which would make every plain member "rank 1").
 * The explicit field exists so the web can tell "this is the whole board"
 * from "this is just you" without inferring it from the entry count (a
 * 1-member team would make that inference ambiguous).
 */
export class RulesLeaderboardResponse extends Schema.Class<RulesLeaderboardResponse>(
  'RulesLeaderboardResponse',
)({
  scope: Schema.Literals(['team', 'self']),
  entries: Schema.Array(RulesLeaderboardEntry),
}) {}

export class RulesLeaderboardForbidden extends Schema.TaggedErrorClass<RulesLeaderboardForbidden>()(
  'RulesLeaderboardForbidden',
  {},
) {}

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
  )
  .add(
    HttpApiEndpoint.get('getRulesLeaderboard', '/teams/:teamId/rules-leaderboard', {
      success: RulesLeaderboardResponse,
      error: RulesLeaderboardForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
