import {
  Auth,
  DisplayName,
  RulesLeaderboard,
  RulesProgress,
  RulesTrainerApi,
  type TeamMember,
  type User,
} from '@sideline/domain';
import type { Scenario } from '@sideline/rules';
import { overallMastery, packageMastery, scoreAttempt } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { type DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership } from '~/api/permissions.js';
import type { InsertableScenarioResult } from '~/repositories/RulesAttemptsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

/**
 * `@sideline/rules/content` is an eager import of all nine packages — fine
 * here (server, not `applications/web`; see `packages/rules/AGENTS.md`'s
 * "the one web must never use"). Built once at module load, not per request:
 * a scenario lookup by id, and the full per-level scenario roster `myProgress`
 * needs so unanswered scenarios still count as `0` (see `engine/mastery.ts`'s
 * `packageMastery` doc — passing only touched scenarios would make mastery
 * trivially reachable).
 *
 * Keyed by plain `string`, not `ScenarioId` — `ScenarioId` is a bare TS brand
 * with no `Schema` and no smart constructor (see `RulesProgress.ts`'s module
 * doc), so a wire-decoded `scenario_id: string` can look it up directly
 * without a cast.
 */
const scenarioById = new Map<string, Scenario>(
  ALL_PACKAGES.flatMap((pkg) => pkg.scenarios.map((scenario) => [scenario.id, scenario] as const)),
);

/**
 * Scores every submitted scenario against its real chain. `scoreAttempt`
 * (`@sideline/rules`) is pure — this is the call site that lifts its result
 * into `Effect`, per `packages/domain/AGENTS.md` ("never wrap a pure
 * function's result in Effect inside the pure module itself").
 *
 * An unknown `scenario_id` (stale client content, a typo, a scenario removed
 * since the client last synced) is scored as incorrect with no steps rather
 * than failing the request — `scoreAttempt` needs a real chain to score
 * against, and `packageMastery` ignores outcomes outside a package's roster
 * anyway, so a junk id is inert at read time (see `RulesTrainerApi.ts`'s
 * module doc).
 */
const scoreSubmittedResults = (
  results: ReadonlyArray<RulesTrainerApi.SubmitAttemptResultInput>,
): Effect.Effect<{
  readonly scored: ReadonlyArray<InsertableScenarioResult>;
  readonly score: number;
  readonly total: number;
}> =>
  Effect.sync(() => {
    const scored = results.map((result): InsertableScenarioResult => {
      const scenario = scenarioById.get(result.scenario_id);
      if (scenario === undefined) {
        return { scenario_id: result.scenario_id, correct: false, steps: [] };
      }
      const picks = result.steps.map((pick) => Option.getOrElse(pick, () => -1));
      const answer = scoreAttempt(scenario.steps, picks);
      return { scenario_id: result.scenario_id, correct: answer.ok, steps: answer.steps };
    });
    return {
      scored,
      score: scored.filter((r) => r.correct).length,
      total: scored.length,
    };
  });

/**
 * Shared step behind `myProgress`, `getRulesLeaderboard`, AND
 * `AchievementEvaluator` (Phase 3b of `docs/plans/rules-trainer.md` —
 * `packagesMastered` is computed on read from `lastCorrectByScenario`, not
 * in SQL): builds per-package mastery (`@sideline/rules`'s
 * `engine/mastery.ts`) from a `scenario_id -> lastCorrectAt` (epoch ms) map.
 * Every package is derived from its FULL scenario roster (`ALL_PACKAGES`),
 * not just the scenarios present in the map — an unanswered scenario must
 * still count as `0`, never be silently absent from the mean.
 */
export const packageMasteriesFromLastCorrect = (
  lastCorrectAtByScenario: ReadonlyMap<string, number>,
  now: number,
) =>
  ALL_PACKAGES.map((pkg) => {
    const scenarioIds = pkg.scenarios.map((scenario) => scenario.id);
    const outcomes = scenarioIds.map((scenarioId) => ({
      scenarioId,
      lastCorrectAt: lastCorrectAtByScenario.get(scenarioId) ?? null,
    }));
    return packageMastery(pkg.level, scenarioIds, outcomes, now);
  });

/**
 * Maps the decayed-mastery computation onto the `RulesMasterySummary` wire
 * DTO.
 */
const buildMasterySummary = (
  rows: ReadonlyArray<{ readonly scenario_id: string; readonly last_correct_at: DateTime.Utc }>,
): RulesProgress.RulesMasterySummary => {
  const lastCorrectAtByScenario = new Map(
    rows.map((row) => [row.scenario_id, row.last_correct_at.epochMilliseconds] as const),
  );

  const masteries = packageMasteriesFromLastCorrect(lastCorrectAtByScenario, Date.now());
  const overall = overallMastery(masteries);

  return new RulesProgress.RulesMasterySummary({
    packages: masteries.map(
      (m) =>
        new RulesProgress.RulesPackageMastery({
          level: m.level,
          strength: m.strength,
          mastered: m.mastered,
          freshCount: m.freshCount,
          everCorrectCount: m.everCorrectCount,
          total: m.total,
        }),
    ),
    overall: new RulesProgress.RulesOverallMastery({
      strength: overall.strength,
      masteredCount: overall.masteredCount,
      totalScenarios: overall.totalScenarios,
    }),
  });
};

// ---------------------------------------------------------------------------
// getRulesLeaderboard (Phase 3a of docs/plans/rules-trainer.md)
// ---------------------------------------------------------------------------

export type RulesLeaderboardRow = {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly user_id: User.UserId;
  readonly username: string;
  readonly name: Option.Option<string>;
  readonly avatar: Option.Option<string>;
  readonly discord_nickname: Option.Option<string>;
  readonly discord_display_name: Option.Option<string>;
  readonly scenario_id: Option.Option<string>;
  readonly last_correct_at: Option.Option<DateTime.Utc>;
};

/**
 * Builds the `getRulesLeaderboard` response.
 *
 * 1. Groups the team-wide rows per member (one row per `(member, scenario
 *    ever answered correctly)` pair, plus a null-scenario row for a member
 *    with none — see `RulesAttemptsRepository.lastCorrectByScenarioForTeam`'s
 *    doc).
 * 2. Computes each member's overall mastery over `ALL_PACKAGES`'s full
 *    roster.
 * 3. Ranks the WHOLE team with `RulesLeaderboard.rankRulesLeaderboard`
 *    BEFORE applying visibility — ranking after filtering would make every
 *    plain member read as rank 1, which `docs/plans/rules-trainer.md`
 *    explicitly calls out as wrong.
 * 4. Applies the plan's visibility decision ("self and captains only"): a
 *    caller with `member:edit` (or a global admin) sees every entry
 *    (`scope: 'team'`); anyone else sees only their own entry
 *    (`scope: 'self'`), still carrying their TRUE team rank.
 */
export const buildRulesLeaderboardResponse = (
  rows: ReadonlyArray<RulesLeaderboardRow>,
  currentUser: Auth.CurrentUser,
  membership: MembershipWithRole,
): RulesTrainerApi.RulesLeaderboardResponse => {
  const rowsByMember = new Map<TeamMember.TeamMemberId, Array<RulesLeaderboardRow>>();
  for (const row of rows) {
    const existing = rowsByMember.get(row.team_member_id);
    if (existing === undefined) {
      rowsByMember.set(row.team_member_id, [row]);
    } else {
      existing.push(row);
    }
  }

  const now = Date.now();

  // Name/avatar fields are looked up again by teamMemberId AFTER ranking
  // (below) rather than threaded through `rankRulesLeaderboard` — that
  // keeps the pure domain module's input/output shape minimal (it only
  // needs the fields it ranks/tiebreaks on), mirroring how `leaderboard.ts`
  // re-looks-up its row by `team_member_id` after `rankLeaderboard`.
  const memberInfoById = new Map<TeamMember.TeamMemberId, RulesLeaderboardRow>();

  const memberMastery = Array.from(rowsByMember.values()).map((memberRows) => {
    const first = memberRows[0];
    memberInfoById.set(first.team_member_id, first);

    const lastCorrectAtByScenario = new Map<string, number>();
    for (const row of memberRows) {
      if (Option.isNone(row.scenario_id) || Option.isNone(row.last_correct_at)) continue;
      lastCorrectAtByScenario.set(
        row.scenario_id.value,
        row.last_correct_at.value.epochMilliseconds,
      );
    }

    const overall = overallMastery(packageMasteriesFromLastCorrect(lastCorrectAtByScenario, now));

    return {
      teamMemberId: first.team_member_id,
      userId: first.user_id,
      username: first.username,
      strength: overall.strength,
      masteredCount: overall.masteredCount,
      totalScenarios: overall.totalScenarios,
    };
  });

  const ranked = RulesLeaderboard.rankRulesLeaderboard(memberMastery);

  // canManage mirrors training-shared.ts's requireManageAccess: member:edit,
  // with global admins bypassing the permission check (see permissions.ts's
  // requireReadAccess for the analogous synthetic-membership bypass).
  const canManage = currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');
  const visible = canManage
    ? ranked
    : ranked.filter((entry) => entry.teamMemberId === membership.id);

  const entries = visible.map((entry) => {
    const info = Option.fromNullishOr(memberInfoById.get(entry.teamMemberId));

    return new RulesTrainerApi.RulesLeaderboardEntry({
      rank: entry.rank,
      teamMemberId: entry.teamMemberId,
      userId: entry.userId,
      username: entry.username,
      name: Option.flatMap(info, (i) => i.name),
      avatar: Option.flatMap(info, (i) => i.avatar),
      displayName: Option.match(info, {
        onNone: () => entry.username,
        onSome: (i) =>
          Option.getOrElse(
            DisplayName.pickDisplayName({
              name: i.name,
              nickname: i.discord_nickname,
              displayName: i.discord_display_name,
              username: Option.some(entry.username),
            }),
            () => entry.username,
          ),
      }),
      strength: entry.strength,
      masteredCount: entry.masteredCount,
      totalScenarios: entry.totalScenarios,
    });
  });

  return new RulesTrainerApi.RulesLeaderboardResponse({
    scope: canManage ? 'team' : 'self',
    entries,
  });
};

export const RulesTrainerApiLive = HttpApiBuilder.group(Api, 'rulesTrainer', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('rulesAttempts', () => RulesAttemptsRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('evaluatorOpt', () => Effect.serviceOption(AchievementEvaluator)),
    Effect.map(({ rulesAttempts, members, evaluatorOpt }) =>
      handlers
        .handle('submitAttempt', ({ payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('scoring', () => scoreSubmittedResults(payload.results)),
            Effect.bind('attempt', ({ currentUser, scoring }) =>
              rulesAttempts.insertAttempt(
                currentUser.id,
                payload.mode,
                payload.packages,
                scoring.score,
                scoring.total,
              ),
            ),
            Effect.tap(({ attempt, scoring }) =>
              rulesAttempts.insertResults(attempt.id, scoring.scored),
            ),
            // Best-effort achievement evaluation (Phase 3b of
            // `docs/plans/rules-trainer.md`) — `rules_attempts` has no
            // `team_id`, so the submit handler resolves the caller's ACTIVE
            // memberships and evaluates once per team, fanning milestones
            // out to every team the caller currently belongs to. Mirrors
            // `activity-logs.ts`'s hook shape exactly: a failed evaluation
            // must never fail the submit.
            Effect.tap(({ currentUser }) =>
              Option.match(evaluatorOpt, {
                onNone: () => Effect.void,
                onSome: (evaluator) =>
                  members.findByUser(currentUser.id).pipe(
                    Effect.flatMap((memberships) =>
                      Effect.forEach(
                        memberships,
                        (membership) => evaluator.evaluate(membership.id),
                        { concurrency: 1 },
                      ),
                    ),
                    Effect.asVoid,
                    Effect.catchCause((cause) =>
                      Effect.logWarning('Achievement evaluation failed', cause),
                    ),
                  ),
              }),
            ),
            Effect.map(({ attempt }) => attempt),
          ),
        )
        .handle('myProgress', () =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('rows', ({ currentUser }) =>
              rulesAttempts.lastCorrectByScenario(currentUser.id),
            ),
            Effect.map(({ rows }) => buildMasterySummary(rows)),
          ),
        )
        .handle('getRulesLeaderboard', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(
                members,
                teamId,
                currentUser.id,
                new RulesTrainerApi.RulesLeaderboardForbidden(),
              ),
            ),
            Effect.bind('rows', () => rulesAttempts.lastCorrectByScenarioForTeam(teamId)),
            Effect.map(({ currentUser, membership, rows }) =>
              buildRulesLeaderboardResponse(rows, currentUser, membership),
            ),
          ),
        ),
    ),
  ),
);
