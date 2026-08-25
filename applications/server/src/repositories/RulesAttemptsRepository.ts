import { RulesProgress, User } from '@sideline/domain';
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

  return {
    insertAttempt,
    insertResults,
    lastCorrectByScenario,
  };
});

export class RulesAttemptsRepository extends ServiceMap.Service<
  RulesAttemptsRepository,
  Effect.Success<typeof make>
>()('api/RulesAttemptsRepository') {
  static readonly Default = Layer.effect(RulesAttemptsRepository, make);
}
