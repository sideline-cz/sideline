import { Discord, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class OverflowCategoryRow extends Schema.Class<OverflowCategoryRow>('OverflowCategoryRow')({
  id: Schema.String,
  team_id: Team.TeamId,
  discord_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  sequence: Schema.Int,
}) {}

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    const _allocate = SqlSchema.findOneOption({
      Request: Schema.Struct({
        team_id: Schema.String,
        sequence: Schema.Int,
      }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (input) => sql`
        INSERT INTO personal_event_overflow_categories (team_id, sequence)
        VALUES (${input.team_id}, ${input.sequence})
        ON CONFLICT (team_id, sequence) DO NOTHING
        RETURNING id
      `,
    });

    const _save = SqlSchema.void({
      Request: Schema.Struct({
        team_id: Schema.String,
        sequence: Schema.Int,
        discord_category_id: Discord.Snowflake,
      }),
      execute: (input) => sql`
        UPDATE personal_event_overflow_categories
        SET discord_category_id = ${input.discord_category_id}
        WHERE team_id = ${input.team_id} AND sequence = ${input.sequence}
      `,
    });

    const _list = SqlSchema.findAll({
      Request: Schema.Struct({ team_id: Schema.String }),
      Result: OverflowCategoryRow,
      execute: (input) => sql`
        SELECT id, team_id, discord_category_id, sequence
        FROM personal_event_overflow_categories
        WHERE team_id = ${input.team_id}
        ORDER BY sequence ASC
      `,
    });

    const allocatePersonalOverflowCategory = (teamId: Team.TeamId, sequence: number) =>
      _allocate({ team_id: teamId, sequence }).pipe(
        Effect.map(Option.map((row) => row.id)),
        catchSqlErrors,
      );

    const savePersonalOverflowCategoryId = (
      teamId: Team.TeamId,
      sequence: number,
      discordCategoryId: Discord.Snowflake,
    ) =>
      _save({
        team_id: teamId,
        sequence,
        discord_category_id: discordCategoryId,
      }).pipe(catchSqlErrors);

    const listPersonalOverflowCategories = (teamId: Team.TeamId) =>
      _list({ team_id: teamId }).pipe(catchSqlErrors);

    return {
      allocatePersonalOverflowCategory,
      savePersonalOverflowCategoryId,
      listPersonalOverflowCategories,
    };
  }),
);

export class PersonalEventOverflowCategoriesRepository extends ServiceMap.Service<
  PersonalEventOverflowCategoriesRepository,
  Effect.Success<typeof make>
>()('api/PersonalEventOverflowCategoriesRepository') {
  static readonly Default = Layer.effect(PersonalEventOverflowCategoriesRepository, make);
}
