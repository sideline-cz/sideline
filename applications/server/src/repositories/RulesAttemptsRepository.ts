import { RulesProgress, Team, TeamMember, User } from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

/**
 * One scenario's stored result, ready for insertion. `steps` is already the
 * plain-JSON shape (`{ pick: number | null, ok: boolean }[]`) `scoreAttempt`
 * (`@sideline/rules`) returns — the caller (the `rulesTrainer` API handler)
 * scores each submitted scenario before it ever reaches this repository, per
 * `packages/rules/AGENTS.md` ("scoreAttempt is shared scoring logic, not a
 * trust boundary").
 */
export type InsertableScenarioResult = {
  readonly scenario_id: string;
  readonly correct: boolean;
  readonly steps: ReadonlyArray<{ readonly pick: number | null; readonly ok: boolean }>;
};

const InsertAttemptInput = Schema.Struct({
  user_id: User.UserId,
  mode: RulesProgress.RulesAttemptMode,
  packages: Schema.Array(RulesProgress.Level),
  score: Schema.Int,
  total: Schema.Int,
});

/**
 * `MAX(a.finished_at)` per correct scenario result — see the module doc on
 * `packages/migrations/src/before/1790400000_create_rules_progress.ts` and
 * `@sideline/rules`'s `engine/mastery.ts` (mastery is computed on read, never
 * materialised).
 */
class LastCorrectRow extends Schema.Class<LastCorrectRow>('LastCorrectRow')({
  scenario_id: Schema.String,
  last_correct_at: Schemas.DateTimeFromDate,
}) {}

/**
 * One `(member, scenario)` row for the team leaderboard (Phase 3a of
 * `docs/plans/rules-trainer.md`). `scenario_id`/`last_correct_at` are
 * `Option` — see `lastCorrectByScenarioForTeam`'s doc for why a member with
 * no correct results still produces exactly one row here (null scenario
 * data), unlike `lastCorrectByScenario` above which produces zero rows for
 * such a user.
 */
/**
 * Exam-mode counts for one user, used by `AchievementEvaluator` for the
 * `rules_first_exam`/`rules_perfect_exam` milestones (Phase 3b of
 * `docs/plans/rules-trainer.md`). `total > 0` in the `perfect_exams` filter
 * matters: a zero-question attempt would otherwise satisfy `score = total`
 * and hand out a perfect-exam achievement for nothing.
 */
class ExamStatsRow extends Schema.Class<ExamStatsRow>('ExamStatsRow')({
  exams_completed: Schema.Int,
  perfect_exams: Schema.Int,
}) {}

class LastCorrectForTeamRow extends Schema.Class<LastCorrectForTeamRow>('LastCorrectForTeamRow')({
  team_member_id: TeamMember.TeamMemberId,
  user_id: User.UserId,
  username: Schema.String,
  name: Schema.OptionFromNullOr(Schema.String),
  avatar: Schema.OptionFromNullOr(Schema.String),
  discord_nickname: Schema.OptionFromNullOr(Schema.String),
  discord_display_name: Schema.OptionFromNullOr(Schema.String),
  scenario_id: Schema.OptionFromNullOr(Schema.String),
  last_correct_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertAttemptQuery = SqlSchema.findOne({
    Request: InsertAttemptInput,
    Result: RulesProgress.RulesAttempt,
    execute: (input) => sql`
      INSERT INTO rules_attempts (user_id, mode, packages, finished_at, score, total)
      VALUES (${input.user_id}, ${input.mode}, ${input.packages}, now(), ${input.score}, ${input.total})
      RETURNING id, user_id, mode, packages, started_at, finished_at, score, total, created_at
    `,
  });

  /**
   * Inserts a completed attempt (`finished_at = now()` — a submitted attempt
   * is always complete, there is no partial/resumable attempt row).
   */
  const insertAttempt = (
    userId: User.UserId,
    mode: RulesProgress.RulesAttemptMode,
    packages: ReadonlyArray<RulesProgress.Level>,
    score: number,
    total: number,
  ) =>
    insertAttemptQuery({ user_id: userId, mode, packages, score, total }).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die('Rules attempt insert returned no row'),
      ),
    );

  /**
   * Multi-row `INSERT ... VALUES (row1),(row2),...`. MUST use
   * `sql.join(',', false)` — `addParens` defaults to `true`, which wraps the
   * whole joined fragment in an extra outer parens pair and Postgres rejects
   * the statement with "INSERT has more target columns than expressions".
   * A single row hides the bug (see `applications/server/AGENTS.md` →
   * "Multi-row VALUES inserts"), so this is only exercised for real against a
   * database in `test/integration/repositories/RulesAttemptsRepository.test.ts`
   * with at least 2 rows.
   *
   * `steps` is pre-encoded with `JSON.stringify` and bound `::jsonb` — on
   * read, node-pg parses JSONB back into JS automatically (unlike the
   * timestamp columns above), so the read side never needs `Schema.parseJson`.
   */
  const insertResults = (
    attemptId: RulesProgress.RulesAttemptId,
    results: ReadonlyArray<InsertableScenarioResult>,
  ) => {
    if (results.length === 0) return Effect.void;
    return sql`
      INSERT INTO rules_scenario_results (attempt_id, scenario_id, correct, steps)
      VALUES ${sql.join(
        ',',
        false,
      )(
        results.map(
          (r) =>
            sql`(${attemptId}, ${r.scenario_id}, ${r.correct}, ${JSON.stringify(r.steps)}::jsonb)`,
        ),
      )}
    `.pipe(Effect.asVoid, catchSqlErrors);
  };

  const lastCorrectByScenarioQuery = SqlSchema.findAll({
    Request: User.UserId,
    Result: LastCorrectRow,
    execute: (userId) => sql`
      SELECT r.scenario_id, MAX(a.finished_at) AS last_correct_at
      FROM rules_scenario_results r
      JOIN rules_attempts a ON a.id = r.attempt_id
      WHERE a.user_id = ${userId} AND r.correct AND a.finished_at IS NOT NULL
      GROUP BY r.scenario_id
    `,
  });

  /** One row per scenario the user has EVER answered correctly, with the most
   * recent correct-answer timestamp — the input `@sideline/rules`'s
   * `packageMastery` needs per package (see `engine/mastery.ts`). */
  const lastCorrectByScenario = (userId: User.UserId) =>
    lastCorrectByScenarioQuery(userId).pipe(catchSqlErrors);

  const examStatsQuery = SqlSchema.findOne({
    Request: User.UserId,
    Result: ExamStatsRow,
    execute: (userId) => sql`
      SELECT
        COUNT(*) FILTER (WHERE mode = 'exam' AND finished_at IS NOT NULL)::int AS exams_completed,
        COUNT(*) FILTER (
          WHERE mode = 'exam' AND finished_at IS NOT NULL AND score = total AND total > 0
        )::int AS perfect_exams
      FROM rules_attempts
      WHERE user_id = ${userId}
    `,
  });

  /**
   * Exam-mode counts for `AchievementEvaluator`'s `rules_first_exam` /
   * `rules_perfect_exam` milestones. A bare `COUNT(*)` with no `GROUP BY`
   * always yields exactly one row (zero counts included when the user has
   * no exam attempts), so `NoSuchElementError` is impossible here — never a
   * real user-facing case.
   */
  const getExamStats = (userId: User.UserId) =>
    examStatsQuery(userId).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die('Rules exam stats query returned no row'),
      ),
    );

  const lastCorrectByScenarioForTeamQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: LastCorrectForTeamRow,
    execute: (teamId) => sql`
      SELECT
        tm.id AS team_member_id,
        u.id AS user_id,
        u.username,
        u.name,
        u.avatar,
        u.discord_nickname,
        u.discord_display_name,
        r.scenario_id,
        MAX(a.finished_at) AS last_correct_at
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN rules_attempts a ON a.user_id = u.id AND a.finished_at IS NOT NULL
      LEFT JOIN rules_scenario_results r ON r.attempt_id = a.id AND r.correct
      WHERE tm.team_id = ${teamId} AND tm.active = true
      GROUP BY tm.id, u.id, u.username, u.name, u.avatar, u.discord_nickname, u.discord_display_name, r.scenario_id
    `,
  });

  /**
   * One row per `(active team member, scenario ever answered correctly)`
   * pair, for the whole team — the input the team leaderboard handler needs
   * to compute every member's mastery in one query (`docs/plans/rules-trainer.md`
   * Phase 3a).
   *
   * Deliberately **LEFT JOINs with no `HAVING`**, unlike `LeaderboardRepository.getLeaderboard`
   * (which excludes zero-activity members with `HAVING COUNT(al.id) > 0`).
   * That is a considered difference, not an oversight: mastery decays
   * (`@sideline/rules`'s `engine/mastery.ts`), so a member who has never
   * practised — or lapsed long enough to decay to strength `0` — is exactly
   * the case a captain wants visible on the board, not silently dropped.
   * The consequence is that a member with zero correct results still
   * produces exactly ONE row here, with `scenario_id` and `last_correct_at`
   * both `Option.none()` (GROUP BY collapses every NULL-`r.scenario_id` row
   * for that member into one group) — callers building
   * `ScenarioOutcome[]` per package MUST skip rows where `scenario_id` is
   * `None` rather than treating it as a real (falsy) scenario id.
   */
  const lastCorrectByScenarioForTeam = (teamId: Team.TeamId) =>
    lastCorrectByScenarioForTeamQuery(teamId).pipe(catchSqlErrors);

  return {
    insertAttempt,
    insertResults,
    lastCorrectByScenario,
    lastCorrectByScenarioForTeam,
    getExamStats,
  };
});

export class RulesAttemptsRepository extends ServiceMap.Service<
  RulesAttemptsRepository,
  Effect.Success<typeof make>
>()('api/RulesAttemptsRepository') {
  static readonly Default = Layer.effect(RulesAttemptsRepository, make);
}
