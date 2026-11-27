import { Auth, Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class AssistantThreadRow extends Schema.Class<AssistantThreadRow>('AssistantThreadRow')({
  team_id: Team.TeamId,
  user_id: Auth.UserId,
  owner_discord_id: Discord.Snowflake,
  owner_locale: User.Locale,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.void({
    Request: Schema.Struct({
      thread_id: Discord.Snowflake,
      team_id: Team.TeamId,
      user_id: Auth.UserId,
    }),
    execute: (r) =>
      sql`INSERT INTO discord_assistant_threads (thread_id, team_id, user_id)
          VALUES (${r.thread_id}, ${r.team_id}, ${r.user_id})
          ON CONFLICT (thread_id) DO NOTHING`,
  });

  const findQuery = SqlSchema.findOneOption({
    Request: Discord.Snowflake,
    Result: AssistantThreadRow,
    execute: (threadId) =>
      sql`SELECT t.team_id, t.user_id, u.discord_id AS owner_discord_id, u.locale AS owner_locale
          FROM discord_assistant_threads t
          JOIN users u ON u.id = t.user_id
          WHERE t.thread_id = ${threadId}`,
  });

  return {
    insert: (input: {
      readonly thread_id: Discord.Snowflake;
      readonly team_id: Team.TeamId;
      readonly user_id: Auth.UserId;
    }) => insertQuery(input).pipe(catchSqlErrors),
    findByThreadId: (threadId: Discord.Snowflake) => findQuery(threadId).pipe(catchSqlErrors),
  };
});

export class DiscordAssistantThreadsRepository extends ServiceMap.Service<
  DiscordAssistantThreadsRepository,
  Effect.Success<typeof make>
>()('api/DiscordAssistantThreadsRepository') {
  static readonly Default = Layer.effect(DiscordAssistantThreadsRepository, make);
}
