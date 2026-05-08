import { type Discord, Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const TeamUpdateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logo_url: Schema.OptionFromNullOr(Schema.String),
  welcome_channel_id: Schema.OptionFromNullOr(Schema.String),
  system_log_channel_id: Schema.OptionFromNullOr(Schema.String),
  welcome_message_template: Schema.OptionFromNullOr(Schema.String),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: Team.Team,
    execute: (id) => sql`SELECT * FROM teams WHERE id = ${id}`,
  });

  const insertQuery = SqlSchema.findOne({
    Request: Team.Team.insert,
    Result: Team.Team,
    execute: (input) => sql`
      INSERT INTO teams (name, guild_id, description, sport, logo_url, created_by)
      VALUES (${input.name}, ${input.guild_id}, ${input.description}, ${input.sport}, ${input.logo_url}, ${input.created_by})
      RETURNING *
    `,
  });

  const findById = (id: Team.TeamId) => findByIdQuery(id).pipe(catchSqlErrors);

  const insert = (input: typeof Team.Team.insert.Type) =>
    insertQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'Team insert returned no row'),
      ),
    );

  const findByGuildQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Team.Team,
    execute: (guildId) => sql`SELECT * FROM teams WHERE guild_id = ${guildId}`,
  });

  const findByGuildId = (guildId: Discord.Snowflake) =>
    findByGuildQuery(guildId).pipe(catchSqlErrors);

  const findByGuildIds = (guildIds: ReadonlyArray<typeof Discord.Snowflake.Type>) => {
    if (guildIds.length === 0) {
      return Effect.succeed([] as Team.Team[]);
    }
    return sql`SELECT * FROM teams WHERE guild_id IN ${sql.in([...guildIds])}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Team.Team))),
      catchSqlErrors,
    );
  };

  const updateTeamQuery = SqlSchema.findOne({
    Request: TeamUpdateInput,
    Result: Team.Team,
    execute: (input) => sql`
      UPDATE teams SET
        name = ${input.name},
        description = ${input.description},
        sport = ${input.sport},
        logo_url = ${input.logo_url},
        welcome_channel_id = ${input.welcome_channel_id},
        system_log_channel_id = ${input.system_log_channel_id},
        welcome_message_template = ${input.welcome_message_template},
        updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `,
  });

  const update = (input: {
    readonly id: Team.TeamId;
    readonly name: string;
    readonly description: Option.Option<string>;
    readonly sport: Option.Option<string>;
    readonly logo_url: Option.Option<string>;
    readonly welcome_channel_id: Option.Option<string>;
    readonly system_log_channel_id: Option.Option<string>;
    readonly welcome_message_template: Option.Option<string>;
  }) =>
    updateTeamQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'Team update returned no row'),
      ),
    );

  return {
    findById,
    insert,
    findByGuildId,
    findByGuildIds,
    update,
  };
});

export class TeamsRepository extends ServiceMap.Service<
  TeamsRepository,
  Effect.Success<typeof make>
>()('api/TeamsRepository') {
  static readonly Default = Layer.effect(TeamsRepository, make);
}
