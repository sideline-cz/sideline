import { Discord, type Team } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class SudoSessionRow extends Schema.Class<SudoSessionRow>('SudoSessionRow')({
  started_at: Schemas.DateTimeFromDate,
  system_channel_id: Discord.Snowflake,
  audit_message_id: Discord.Snowflake,
}) {}

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    const _upsert = SqlSchema.void({
      Request: Schema.Struct({
        team_id: Schema.String,
        discord_user_id: Discord.Snowflake,
        system_channel_id: Discord.Snowflake,
        audit_message_id: Discord.Snowflake,
        started_at: Schemas.DateTimeFromDate,
      }),
      execute: (input) => sql`
        INSERT INTO sudo_sessions (team_id, discord_user_id, system_channel_id, audit_message_id, started_at)
        VALUES (${input.team_id}, ${input.discord_user_id}, ${input.system_channel_id}, ${input.audit_message_id}, ${input.started_at})
        ON CONFLICT (team_id, discord_user_id) DO UPDATE SET
          system_channel_id = EXCLUDED.system_channel_id,
          audit_message_id = EXCLUDED.audit_message_id,
          started_at = EXCLUDED.started_at
      `,
    });

    const _fetchAndDelete = SqlSchema.findOneOption({
      Request: Schema.Struct({
        team_id: Schema.String,
        discord_user_id: Discord.Snowflake,
      }),
      Result: SudoSessionRow,
      execute: (input) => sql`
        DELETE FROM sudo_sessions
        WHERE team_id = ${input.team_id} AND discord_user_id = ${input.discord_user_id}
        RETURNING started_at, system_channel_id, audit_message_id
      `,
    });

    const upsert = (params: {
      readonly team_id: Team.TeamId;
      readonly discord_user_id: Discord.Snowflake;
      readonly system_channel_id: Discord.Snowflake;
      readonly audit_message_id: Discord.Snowflake;
      readonly started_at: SudoSessionRow['started_at'];
    }) => _upsert(params).pipe(catchSqlErrors);

    const fetchAndDelete = (params: {
      readonly team_id: Team.TeamId;
      readonly discord_user_id: Discord.Snowflake;
    }) => _fetchAndDelete(params).pipe(catchSqlErrors);

    return { upsert, fetchAndDelete };
  }),
);

export class SudoSessionsRepository extends ServiceMap.Service<
  SudoSessionsRepository,
  Effect.Success<typeof make>
>()('api/SudoSessionsRepository') {
  static readonly Default = Layer.effect(SudoSessionsRepository, make);
}
