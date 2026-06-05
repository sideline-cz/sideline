import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamChannelId } from '~/models/TeamChannel.js';
import { AccessLevel } from '~/models/TeamChannelAccess.js';

export class ChannelAccessGrant extends Schema.Class<ChannelAccessGrant>('ChannelAccessGrant')({
  groupId: GroupId,
  accessLevel: AccessLevel,
}) {}

export class ChannelInfo extends Schema.Class<ChannelInfo>('ChannelInfo')({
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  teamChannelId: Schema.OptionFromNullOr(TeamChannelId),
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  managed: Schema.Boolean,
  type: Schema.Number,
  archived: Schema.Boolean,
  accessCount: Schema.Number,
}) {}

export class ChannelDetail extends Schema.Class<ChannelDetail>('ChannelDetail')({
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  teamChannelId: Schema.OptionFromNullOr(TeamChannelId),
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  managed: Schema.Boolean,
  type: Schema.Number,
  archived: Schema.Boolean,
  accessCount: Schema.Number,
  grants: Schema.Array(ChannelAccessGrant),
}) {}

export class ChannelListResponse extends Schema.Class<ChannelListResponse>('ChannelListResponse')({
  canManage: Schema.Boolean,
  guildLinked: Schema.Boolean,
  archiveCategoryId: Schema.OptionFromNullOr(Snowflake),
  channels: Schema.Array(ChannelInfo),
}) {}

export const CreateChannelRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  category: Schema.OptionFromNullOr(Schema.NonEmptyString),
});
export type CreateChannelRequest = Schema.Schema.Type<typeof CreateChannelRequest>;

export const RenameChannelRequest = Schema.Struct({
  name: Schema.NonEmptyString,
});
export type RenameChannelRequest = Schema.Schema.Type<typeof RenameChannelRequest>;

export const SetChannelAccessRequest = Schema.Struct({
  grants: Schema.Array(ChannelAccessGrant),
});
export type SetChannelAccessRequest = Schema.Schema.Type<typeof SetChannelAccessRequest>;

export class ChannelForbidden extends Schema.TaggedErrorClass<ChannelForbidden>()(
  'ChannelForbidden',
  {},
) {}

export class ChannelNotFound extends Schema.TaggedErrorClass<ChannelNotFound>()(
  'ChannelNotFound',
  {},
) {}

export class ChannelNameAlreadyTaken extends Schema.TaggedErrorClass<ChannelNameAlreadyTaken>()(
  'ChannelNameAlreadyTaken',
  {},
) {}

export class ArchiveCategoryNotConfigured extends Schema.TaggedErrorClass<ArchiveCategoryNotConfigured>()(
  'ArchiveCategoryNotConfigured',
  {},
) {}

export class ChannelNotArchivable extends Schema.TaggedErrorClass<ChannelNotArchivable>()(
  'ChannelNotArchivable',
  {},
) {}

export class ChannelNotAdoptable extends Schema.TaggedErrorClass<ChannelNotAdoptable>()(
  'ChannelNotAdoptable',
  {},
) {}

export class ChannelAdoptionNameConflict extends Schema.TaggedErrorClass<ChannelAdoptionNameConflict>()(
  'ChannelAdoptionNameConflict',
  {},
) {}

export const BulkArchiveDiscordChannelsRequest = Schema.Struct({
  discordChannelIds: Schema.Array(Snowflake),
});
export type BulkArchiveDiscordChannelsRequest = Schema.Schema.Type<
  typeof BulkArchiveDiscordChannelsRequest
>;

const BulkArchiveSkipReason = Schema.Literals([
  'already_archived',
  'is_category',
  'is_archive_category',
  'not_found',
]);

export class ChannelBulkArchiveResult extends Schema.Class<ChannelBulkArchiveResult>(
  'ChannelBulkArchiveResult',
)({
  archived: Schema.Array(Snowflake),
  skipped: Schema.Array(
    Schema.Struct({
      discordChannelId: Snowflake,
      reason: BulkArchiveSkipReason,
    }),
  ),
  failed: Schema.Array(Schema.Struct({ discordChannelId: Snowflake })),
}) {}

export class ChannelApiGroup extends HttpApiGroup.make('channel')
  .add(
    HttpApiEndpoint.get('listChannels', '/teams/:teamId/channels', {
      success: ChannelListResponse,
      error: ChannelForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createChannel', '/teams/:teamId/channels', {
      success: ChannelDetail.pipe(HttpApiSchema.status(201)),
      error: [
        ChannelForbidden.pipe(HttpApiSchema.status(403)),
        ChannelNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateChannelRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getChannel', '/teams/:teamId/channels/:channelId', {
      success: ChannelDetail,
      error: [
        ChannelForbidden.pipe(HttpApiSchema.status(403)),
        ChannelNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, channelId: TeamChannelId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('renameChannel', '/teams/:teamId/channels/:channelId/name', {
      success: ChannelDetail,
      error: [
        ChannelForbidden.pipe(HttpApiSchema.status(403)),
        ChannelNotFound.pipe(HttpApiSchema.status(404)),
        ChannelNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: RenameChannelRequest,
      params: { teamId: TeamId, channelId: TeamChannelId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('archiveChannel', '/teams/:teamId/channels/:channelId/archive', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        ChannelForbidden.pipe(HttpApiSchema.status(403)),
        ChannelNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, channelId: TeamChannelId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('setAccess', '/teams/:teamId/channels/:channelId/access', {
      success: ChannelDetail,
      error: [
        ChannelForbidden.pipe(HttpApiSchema.status(403)),
        ChannelNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: SetChannelAccessRequest,
      params: { teamId: TeamId, channelId: TeamChannelId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'archiveDiscordChannel',
      '/teams/:teamId/discord-channels/:discordChannelId/archive',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          ArchiveCategoryNotConfigured.pipe(HttpApiSchema.status(409)),
          ChannelNotArchivable.pipe(HttpApiSchema.status(409)),
          ChannelForbidden.pipe(HttpApiSchema.status(403)),
          ChannelNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, discordChannelId: Snowflake },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'adoptDiscordChannel',
      '/teams/:teamId/discord-channels/:discordChannelId/adopt',
      {
        success: ChannelDetail,
        error: [
          ChannelForbidden.pipe(HttpApiSchema.status(403)),
          ChannelNotFound.pipe(HttpApiSchema.status(404)),
          ChannelNotAdoptable.pipe(HttpApiSchema.status(409)),
          ChannelAdoptionNameConflict.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, discordChannelId: Snowflake },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'bulkArchiveDiscordChannels',
      '/teams/:teamId/discord-channels/bulk-archive',
      {
        success: ChannelBulkArchiveResult,
        error: [
          ChannelForbidden.pipe(HttpApiSchema.status(403)),
          ArchiveCategoryNotConfigured.pipe(HttpApiSchema.status(409)),
        ],
        payload: BulkArchiveDiscordChannelsRequest,
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  ) {}
