import { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const PendingJoinRow = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isUUID())),
  guild_id: Discord.Snowflake,
  discord_id: Schema.String,
  access_token: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _enqueue = SqlSchema.void({
    Request: Schema.Struct({ user_id: User.UserId, team_id: Team.TeamId }),
    execute: (input) => sql`
      INSERT INTO pending_guild_joins (user_id, team_id)
      VALUES (${input.user_id}, ${input.team_id})
      ON CONFLICT (user_id, team_id) DO UPDATE SET
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        created_at = now(),
        processed_at = NULL
    `,
  });

  const _listPending = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingJoinRow,
    execute: () => sql`
      SELECT pgj.id, t.guild_id, u.discord_id, oc.access_token
      FROM pending_guild_joins pgj
      JOIN teams t ON t.id = pgj.team_id
      JOIN users u ON u.id = pgj.user_id
      JOIN oauth_connections oc ON oc.user_id = pgj.user_id AND oc.provider = 'discord'
      WHERE pgj.status = 'pending'
      ORDER BY pgj.created_at ASC
      LIMIT 50
    `,
  });

  const _markDone = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String.pipe(Schema.check(Schema.isUUID())) }),
    execute: (input) => sql`
      UPDATE pending_guild_joins
      SET status = 'done', processed_at = now()
      WHERE id = ${input.id}
    `,
  });

  const _markFailed = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String.pipe(Schema.check(Schema.isUUID())),
      error: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE pending_guild_joins
      SET status = 'failed', attempts = attempts + 1, last_error = ${input.error}, processed_at = now()
      WHERE id = ${input.id}
    `,
  });

  const enqueue = (userId: User.UserId, teamId: Team.TeamId) =>
    _enqueue({ user_id: userId, team_id: teamId }).pipe(catchSqlErrors);

  const listPending = () => _listPending().pipe(catchSqlErrors);

  const markDone = (id: string) => _markDone({ id }).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) => _markFailed({ id, error }).pipe(catchSqlErrors);

  return { enqueue, listPending, markDone, markFailed };
});

export class PendingGuildJoinsRepository extends ServiceMap.Service<
  PendingGuildJoinsRepository,
  Effect.Success<typeof make>
>()('api/PendingGuildJoinsRepository') {
  static readonly Default = Layer.effect(PendingGuildJoinsRepository, make);
}
