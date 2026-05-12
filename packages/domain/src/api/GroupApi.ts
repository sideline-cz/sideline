import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import { GroupId } from '~/models/GroupModel.js';
import { RoleId } from '~/models/Role.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const HexColor = Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)));

export class GroupInfo extends Schema.Class<GroupInfo>('GroupInfo')({
  groupId: GroupId,
  teamId: TeamId,
  parentId: Schema.OptionFromNullOr(GroupId),
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(HexColor),
  memberCount: Schema.Number,
  discordChannelProvisioning: Schema.Boolean,
}) {}

export class GroupDetail extends Schema.Class<GroupDetail>('GroupDetail')({
  groupId: GroupId,
  teamId: TeamId,
  parentId: Schema.OptionFromNullOr(GroupId),
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(HexColor),
  roles: Schema.Array(
    Schema.Struct({
      roleId: RoleId,
      roleName: Schema.String,
    }),
  ),
  members: Schema.Array(
    Schema.Struct({
      memberId: TeamMemberId,
      name: Schema.OptionFromNullOr(Schema.String),
      username: Schema.String,
    }),
  ),
  discordChannelProvisioning: Schema.Boolean,
}) {}

export const CreateGroupRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  parentId: Schema.OptionFromNullOr(GroupId),
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(HexColor),
});
export type CreateGroupRequest = Schema.Schema.Type<typeof CreateGroupRequest>;

export const UpdateGroupRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(HexColor),
});
export type UpdateGroupRequest = Schema.Schema.Type<typeof UpdateGroupRequest>;

export const AddGroupMemberRequest = Schema.Struct({
  memberId: TeamMemberId,
});
export type AddGroupMemberRequest = Schema.Schema.Type<typeof AddGroupMemberRequest>;

export const AssignGroupRoleRequest = Schema.Struct({
  roleId: RoleId,
});
export type AssignGroupRoleRequest = Schema.Schema.Type<typeof AssignGroupRoleRequest>;

export const MoveGroupRequest = Schema.Struct({
  parentId: Schema.OptionFromNullOr(GroupId),
});
export type MoveGroupRequest = Schema.Schema.Type<typeof MoveGroupRequest>;

export class ChannelMappingInfo extends Schema.Class<ChannelMappingInfo>('ChannelMappingInfo')({
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  discordChannelName: Schema.OptionFromNullOr(Schema.String),
  discordRoleId: Schema.OptionFromNullOr(Snowflake),
}) {}

export const SetChannelMappingRequest = Schema.Struct({
  discordChannelId: Snowflake,
});
export type SetChannelMappingRequest = Schema.Schema.Type<typeof SetChannelMappingRequest>;

export class DiscordChannelInfo extends Schema.Class<DiscordChannelInfo>('DiscordChannelInfo')({
  id: Snowflake,
  name: Schema.String,
  type: Schema.Number,
  parentId: Schema.OptionFromNullOr(Snowflake),
}) {}

export class DiscordRoleInfo extends Schema.Class<DiscordRoleInfo>('DiscordRoleInfo')({
  id: Snowflake,
  name: Schema.String,
  color: Schema.Number,
  position: Schema.Number,
  managed: Schema.Boolean,
}) {}

export class SyncRoleMembersResult extends Schema.Class<SyncRoleMembersResult>(
  'SyncRoleMembersResult',
)({
  addedCount: Schema.Number,
  removedCount: Schema.Number,
  skippedCount: Schema.Number,
}) {}

export class GroupNotFound extends Schema.TaggedErrorClass<GroupNotFound>()('GroupNotFound', {}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('GroupForbidden', {}) {}

export class MemberNotFound extends Schema.TaggedErrorClass<MemberNotFound>()(
  'GroupMemberNotFound',
  {},
) {}

export class GroupNameAlreadyTaken extends Schema.TaggedErrorClass<GroupNameAlreadyTaken>()(
  'GroupNameAlreadyTaken',
  {},
) {}

export class GroupApiGroup extends HttpApiGroup.make('group')
  .add(
    HttpApiEndpoint.get('listGroups', '/teams/:teamId/groups', {
      success: Schema.Array(GroupInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createGroup', '/teams/:teamId/groups', {
      success: GroupInfo.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateGroupRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getGroup', '/teams/:teamId/groups/:groupId', {
      success: GroupDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateGroup', '/teams/:teamId/groups/:groupId', {
      success: GroupInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
        GroupNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateGroupRequest,
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteGroup', '/teams/:teamId/groups/:groupId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('addGroupMember', '/teams/:teamId/groups/:groupId/members', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
        MemberNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: AddGroupMemberRequest,
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'removeGroupMember',
      '/teams/:teamId/groups/:groupId/members/:memberId',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          GroupNotFound.pipe(HttpApiSchema.status(404)),
          MemberNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, groupId: GroupId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('assignGroupRole', '/teams/:teamId/groups/:groupId/roles', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: AssignGroupRoleRequest,
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('unassignGroupRole', '/teams/:teamId/groups/:groupId/roles/:roleId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId, roleId: RoleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('moveGroup', '/teams/:teamId/groups/:groupId/parent', {
      success: GroupInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: MoveGroupRequest,
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getChannelMapping', '/teams/:teamId/groups/:groupId/channel-mapping', {
      success: Schema.OptionFromNullOr(ChannelMappingInfo),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('setChannelMapping', '/teams/:teamId/groups/:groupId/channel-mapping', {
      success: ChannelMappingInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: SetChannelMappingRequest,
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'deleteChannelMapping',
      '/teams/:teamId/groups/:groupId/channel-mapping',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          GroupNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, groupId: GroupId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createChannel', '/teams/:teamId/groups/:groupId/create-channel', {
      success: Schema.Void.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('syncRoleMembers', '/teams/:teamId/groups/:groupId/sync-role-members', {
      success: SyncRoleMembersResult,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, groupId: GroupId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listDiscordChannels', '/teams/:teamId/discord-channels', {
      success: Schema.Array(DiscordChannelInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listDiscordRoles', '/teams/:teamId/discord-roles', {
      success: Schema.Array(DiscordRoleInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
