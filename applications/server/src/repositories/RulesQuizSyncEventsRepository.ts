import { Discord, Team } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

/**
 * The outbox for the scheduled rules quiz: `RulesQuizCron` writes one row when
 * a team's moment arrives, the bot drains it and posts.
 *
 * The guild id is resolved here rather than carried from the cron, matching
 * `AchievementSyncEventsRepository` — the bot needs it to open a thread, and
 * `teams.guild_id` is the only place it lives.
 */

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  channel_id: Discord.Snowflake,
  scenario_id: Schema.String,
  scheduled_for: Schemas.DateTimeFromDate,
});

export class RulesQuizSyncEventRow extends Schema.Class<RulesQuizSyncEventRow>(
  'RulesQuizSyncEventRow',
)({
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  channel_id: Discord.Snowflake,
  scenario_id: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * `ON CONFLICT DO NOTHING` against `UNIQUE (team_id, scheduled_for)` is what
   * makes the cron safe to run twice. Its "is it this team's minute?" check
   * spans a 60-second window, so an overlapping or retried tick would
   * otherwise post the same situation to the channel twice.
   */
  const insertEvent = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO rules_quiz_sync_events (team_id, channel_id, scenario_id, scheduled_for)
      VALUES (${input.team_id}, ${input.channel_id}, ${input.scenario_id}, ${input.scheduled_for})
      ON CONFLICT (team_id, scheduled_for) DO NOTHING
    `,
  });

  /**
   * Unprocessed events, newest last. Joins `teams` for the guild id — an event
   * whose team has no linked guild is skipped entirely rather than handed to
   * the bot, which could do nothing with it.
   */
  const findUnprocessed = SqlSchema.findAll({
    Request: Schema.Number,
    Result: RulesQuizSyncEventRow,
    execute: (limit) => sql`
      SELECT e.id, e.team_id, t.guild_id, e.channel_id, e.scenario_id
      FROM rules_quiz_sync_events e
      JOIN teams t ON t.id = e.team_id
      WHERE e.processed_at IS NULL
        AND t.guild_id IS NOT NULL
      ORDER BY e.scheduled_for ASC
      LIMIT ${limit}
    `,
  });

  const markProcessed = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      UPDATE rules_quiz_sync_events
      SET processed_at = now()
      WHERE id = ${input.id}::uuid
    `,
  });

  /**
   * A failure is recorded but the row is left UNPROCESSED, so the next poll
   * retries it — a Discord blip must not silently drop a team's quiz. `attempts`
   * is what makes a permanently-broken event visible rather than invisible.
   */
  const markFailed = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String, error: Schema.String }),
    execute: (input) => sql`
      UPDATE rules_quiz_sync_events
      SET attempts = attempts + 1, last_error = ${input.error}
      WHERE id = ${input.id}::uuid
    `,
  });

  return {
    insertEvent: (input: typeof InsertInput.Type) => insertEvent(input).pipe(catchSqlErrors),
    findUnprocessed: (limit: number) => findUnprocessed(limit).pipe(catchSqlErrors),
    markProcessed: (id: string) => markProcessed({ id }).pipe(catchSqlErrors),
    markFailed: (id: string, error: string) => markFailed({ id, error }).pipe(catchSqlErrors),
  };
});

export class RulesQuizSyncEventsRepository extends ServiceMap.Service<
  RulesQuizSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/RulesQuizSyncEventsRepository') {
  static readonly Default = Layer.effect(RulesQuizSyncEventsRepository, make);
}
