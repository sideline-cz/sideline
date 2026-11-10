import { Discord, Team, TeamChannel } from '@sideline/domain';
import { LogicError, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class ChannelNameAlreadyTakenError extends Schema.TaggedErrorClass<ChannelNameAlreadyTakenError>()(
  'ChannelNameAlreadyTakenError',
  {},
) {}

export class DiscordChannelAlreadyAdoptedError extends Schema.TaggedErrorClass<DiscordChannelAlreadyAdoptedError>()(
  'DiscordChannelAlreadyAdoptedError',
  {},
) {}

class ChannelRow extends Schema.Class<ChannelRow>('ChannelRow')({
  id: TeamChannel.TeamChannelId,
  team_id: Team.TeamId,
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(Schema.String),
  position: Schema.Number,
  archived: Schema.Boolean,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

// One team channel plus the state of its queued Discord changes. "pending": a managed sync event
// for it is not processed yet (not polled, or a transient failure the bot retries). "failed": no
// pending event, and the latest one failed for good. "ok": everything queued was applied.
export class TeamChannelSyncStateRow extends Schema.Class<TeamChannelSyncStateRow>(
  'TeamChannelSyncStateRow',
)({
  id: TeamChannel.TeamChannelId,
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  archived: Schema.Boolean,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  access_count: Schema.Number,
  sync_state: Schema.Literals(['pending', 'failed', 'ok']),
}) {}

const FindByIdInput = Schema.Struct({ id: TeamChannel.TeamChannelId });
const FindByTeamInput = Schema.Struct({ team_id: Team.TeamId });

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  category: Schema.OptionFromNullOr(Schema.String),
});

const InsertAdoptedInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  discord_channel_id: Discord.Snowflake,
});

const RenameInput = Schema.Struct({
  id: TeamChannel.TeamChannelId,
  name: Schema.String,
});

const UpdateOrganizationInput = Schema.Struct({
  id: TeamChannel.TeamChannelId,
  category: Schema.OptionFromNullOr(Schema.String),
  position: Schema.Number,
});

const SetArchivedInput = Schema.Struct({
  id: TeamChannel.TeamChannelId,
  archived: Schema.Boolean,
});

const UpsertDiscordChannelIdInput = Schema.Struct({
  id: TeamChannel.TeamChannelId,
  discord_channel_id: Discord.Snowflake,
});

const DeleteInput = Schema.Struct({ id: TeamChannel.TeamChannelId });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByIdQuery = SqlSchema.findOneOption({
    Request: FindByIdInput,
    Result: ChannelRow,
    execute: (input) => sql`
      SELECT id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
      FROM team_channels
      WHERE id = ${input.id}
    `,
  });

  const findAllByTeamQuery = SqlSchema.findAll({
    Request: FindByTeamInput,
    Result: ChannelRow,
    execute: (input) => sql`
      SELECT id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
      FROM team_channels
      WHERE team_id = ${input.team_id}
      ORDER BY category NULLS FIRST, position ASC, name ASC
    `,
  });

  // Revoke rows carry no team_channel_id, only existing_channel_id: hence the OR.
  const findAllByTeamWithSyncStateQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: TeamChannelSyncStateRow,
    execute: (teamId) => sql`
      SELECT tc.id, tc.name, tc.category, tc.archived, tc.discord_channel_id,
             (SELECT COUNT(*)::int FROM team_channel_access tca WHERE tca.team_channel_id = tc.id) AS access_count,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM channel_sync_events e
                 WHERE e.team_id = tc.team_id
                   AND e.entity_type = 'managed'
                   AND e.processed_at IS NULL
                   AND (e.team_channel_id = tc.id OR e.existing_channel_id = tc.discord_channel_id)
               ) THEN 'pending'
               WHEN (
                 SELECT e.error FROM channel_sync_events e
                 WHERE e.team_id = tc.team_id
                   AND e.entity_type = 'managed'
                   AND (e.team_channel_id = tc.id OR e.existing_channel_id = tc.discord_channel_id)
                 ORDER BY e.created_at DESC, e.id DESC
                 LIMIT 1
               ) IS NOT NULL THEN 'failed'
               ELSE 'ok'
             END AS sync_state
      FROM team_channels tc
      WHERE tc.team_id = ${teamId}
      ORDER BY tc.name, tc.id
    `,
  });

  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: ChannelRow,
    execute: (input) => sql`
      INSERT INTO team_channels (team_id, name, emoji, category)
      VALUES (${input.team_id}, ${input.name}, ${input.emoji}, ${input.category})
      RETURNING id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
    `,
  });

  const insertAdoptedQuery = SqlSchema.findOne({
    Request: InsertAdoptedInput,
    Result: ChannelRow,
    execute: (input) => sql`
      INSERT INTO team_channels (team_id, name, category, discord_channel_id, archived)
      VALUES (${input.team_id}, ${input.name}, ${input.category}, ${input.discord_channel_id}, false)
      RETURNING id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
    `,
  });

  const renameQuery = SqlSchema.findOne({
    Request: RenameInput,
    Result: ChannelRow,
    execute: (input) => sql`
      UPDATE team_channels
      SET name = ${input.name}
      WHERE id = ${input.id}
      RETURNING id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
    `,
  });

  const updateOrganizationQuery = SqlSchema.findOne({
    Request: UpdateOrganizationInput,
    Result: ChannelRow,
    execute: (input) => sql`
      UPDATE team_channels
      SET category = ${input.category}, position = ${input.position}
      WHERE id = ${input.id}
      RETURNING id, team_id, name, category, emoji, position, archived, discord_channel_id, discord_role_id
    `,
  });

  const setArchivedQuery = SqlSchema.void({
    Request: SetArchivedInput,
    execute: (input) => sql`
      UPDATE team_channels
      SET archived = ${input.archived}
      WHERE id = ${input.id}
    `,
  });

  const upsertDiscordChannelIdQuery = SqlSchema.void({
    Request: UpsertDiscordChannelIdInput,
    execute: (input) => sql`
      UPDATE team_channels
      SET discord_channel_id = ${input.discord_channel_id}
      WHERE id = ${input.id}
    `,
  });

  const clearDiscordChannelIdQuery = SqlSchema.void({
    Request: DeleteInput,
    execute: (input) => sql`
      UPDATE team_channels
      SET discord_channel_id = NULL
      WHERE id = ${input.id}
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: DeleteInput,
    execute: (input) => sql`DELETE FROM team_channels WHERE id = ${input.id}`,
  });

  const findById = (channelId: TeamChannel.TeamChannelId) =>
    findByIdQuery({ id: channelId }).pipe(catchSqlErrors);

  const findAllByTeam = (teamId: Team.TeamId) =>
    findAllByTeamQuery({ team_id: teamId }).pipe(catchSqlErrors);

  const findAllByTeamWithSyncState = (teamId: Team.TeamId) =>
    findAllByTeamWithSyncStateQuery(teamId).pipe(catchSqlErrors);

  const insert = (
    teamId: Team.TeamId,
    name: string,
    category: Option.Option<string>,
    emoji: Option.Option<string>,
  ) =>
    insertQuery({ team_id: teamId, name, emoji, category }).pipe(
      SqlErrors.catchUniqueViolation(() => new ChannelNameAlreadyTakenError()),
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => `insert channel "${name}" returned no row`),
      ),
      catchSqlErrors,
    );

  const insertAdopted = (
    teamId: Team.TeamId,
    name: string,
    category: Option.Option<string>,
    discordChannelId: Discord.Snowflake,
  ) =>
    insertAdoptedQuery({
      team_id: teamId,
      name,
      category,
      discord_channel_id: discordChannelId,
    }).pipe(
      SqlErrors.catchUniqueViolationOn(
        'uq_team_channels_discord_channel',
        () => new DiscordChannelAlreadyAdoptedError(),
      ),
      SqlErrors.catchUniqueViolationOn(
        'uq_team_channels_team_name_active',
        () => new ChannelNameAlreadyTakenError(),
      ),
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(
          () => `insertAdopted channel "${name}" for discord ${discordChannelId} returned no row`,
        ),
      ),
      catchSqlErrors,
    );

  const rename = (channelId: TeamChannel.TeamChannelId, name: string) =>
    renameQuery({ id: channelId, name }).pipe(
      SqlErrors.catchUniqueViolation(() => new ChannelNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const updateOrganization = (
    channelId: TeamChannel.TeamChannelId,
    category: Option.Option<string>,
    position: number,
  ) => updateOrganizationQuery({ id: channelId, category, position }).pipe(catchSqlErrors);

  const setArchived = (channelId: TeamChannel.TeamChannelId, archived: boolean) =>
    setArchivedQuery({ id: channelId, archived }).pipe(catchSqlErrors);

  const deleteChannel = (channelId: TeamChannel.TeamChannelId) =>
    deleteQuery({ id: channelId }).pipe(catchSqlErrors);

  const upsertDiscordChannelId = (
    channelId: TeamChannel.TeamChannelId,
    discordChannelId: Discord.Snowflake,
  ) =>
    upsertDiscordChannelIdQuery({ id: channelId, discord_channel_id: discordChannelId }).pipe(
      catchSqlErrors,
    );

  const clearDiscordChannelId = (channelId: TeamChannel.TeamChannelId) =>
    clearDiscordChannelIdQuery({ id: channelId }).pipe(catchSqlErrors);

  return {
    findById,
    findAllByTeam,
    findAllByTeamWithSyncState,
    insert,
    insertAdopted,
    rename,
    updateOrganization,
    setArchived,
    delete: deleteChannel,
    upsertDiscordChannelId,
    clearDiscordChannelId,
  };
});

export class TeamChannelsRepository extends ServiceMap.Service<
  TeamChannelsRepository,
  Effect.Success<typeof make>
>()('api/TeamChannelsRepository') {
  static readonly Default = Layer.effect(TeamChannelsRepository, make);
}
