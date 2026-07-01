import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { HexColor, SyncRoleMembersResult } from '~/api/GroupApi.js';
import { Snowflake } from '~/models/Discord.js';
import { Permission } from '~/models/Role.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { Gender, UserId } from '~/models/User.js';

export { HexColor, SyncRoleMembersResult };

export class BackfillRosterRolesResult extends Schema.Class<BackfillRosterRolesResult>(
  'BackfillRosterRolesResult',
)({
  processedCount: Schema.Number,
  remainingCount: Schema.Number,
}) {}

export class RosterPlayer extends Schema.Class<RosterPlayer>('RosterPlayer')({
  memberId: TeamMemberId,
  userId: UserId,
  discordId: Schema.String,
  roleNames: Schema.Array(Schema.String),
  permissions: Schema.Array(Permission),
  name: Schema.OptionFromNullOr(Schema.String),
  birthDate: Schema.OptionFromNullOr(Schema.String),
  gender: Schema.OptionFromNullOr(Gender),
  jerseyNumber: Schema.OptionFromNullOr(Schema.Number),
  username: Schema.String,
  avatar: Schema.OptionFromNullOr(Schema.String),
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
  joinedAt: Schema.String,
  active: Schema.Boolean,
}) {}

export const UpdatePlayerRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(Schema.String),
  birthDate: Schema.OptionFromNullOr(Schema.String),
  gender: Schema.OptionFromNullOr(Gender),
  jerseyNumber: Schema.OptionFromNullOr(Schema.Number),
});
export type UpdatePlayerRequest = Schema.Schema.Type<typeof UpdatePlayerRequest>;

export class PlayerNotFound extends Schema.TaggedErrorClass<PlayerNotFound>()(
  'PlayerNotFound',
  {},
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('Forbidden', {}) {}

export class ChannelAlreadyLinked extends Schema.TaggedErrorClass<ChannelAlreadyLinked>()(
  'ChannelAlreadyLinked',
  {},
) {}

export class RosterNotFound extends Schema.TaggedErrorClass<RosterNotFound>()(
  'RosterNotFound',
  {},
) {}

export class RosterInfo extends Schema.Class<RosterInfo>('RosterInfo')({
  rosterId: RosterId,
  teamId: TeamId,
  name: Schema.String,
  active: Schema.Boolean,
  memberCount: Schema.Number,
  createdAt: Schema.String,
  color: Schema.OptionFromNullOr(HexColor),
  emoji: Schema.OptionFromNullOr(Schema.String),
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  discordChannelName: Schema.OptionFromNullOr(Schema.String),
  discordChannelProvisioning: Schema.Boolean,
}) {}

export class RosterListResponse extends Schema.Class<RosterListResponse>('RosterListResponse')({
  canManage: Schema.Boolean,
  rosters: Schema.Array(RosterInfo),
}) {}

export class RosterDetail extends Schema.Class<RosterDetail>('RosterDetail')({
  rosterId: RosterId,
  teamId: TeamId,
  name: Schema.String,
  active: Schema.Boolean,
  createdAt: Schema.String,
  color: Schema.OptionFromNullOr(HexColor),
  emoji: Schema.OptionFromNullOr(Schema.String),
  members: Schema.Array(RosterPlayer),
  canManage: Schema.Boolean,
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  discordChannelName: Schema.OptionFromNullOr(Schema.String),
  discordChannelProvisioning: Schema.Boolean,
}) {}

export const CreateRosterRequest = Schema.Struct({
  name: Schema.String,
  color: Schema.OptionFromNullOr(HexColor),
  emoji: Schema.OptionFromNullOr(Schema.String),
});
export type CreateRosterRequest = Schema.Schema.Type<typeof CreateRosterRequest>;

export const UpdateRosterRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(Schema.String),
  active: Schema.OptionFromNullOr(Schema.Boolean),
  color: Schema.OptionFromNullOr(HexColor),
  emoji: Schema.OptionFromNullOr(Schema.String),
  discordChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
});
export type UpdateRosterRequest = Schema.Schema.Type<typeof UpdateRosterRequest>;

export const AddRosterMemberRequest = Schema.Struct({
  memberId: TeamMemberId,
});
export type AddRosterMemberRequest = Schema.Schema.Type<typeof AddRosterMemberRequest>;

export class RosterApiGroup extends HttpApiGroup.make('roster')
  .add(
    HttpApiEndpoint.get('listMembers', '/teams/:teamId/members', {
      success: Schema.Array(RosterPlayer),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getMember', '/teams/:teamId/members/:memberId', {
      success: RosterPlayer,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateMember', '/teams/:teamId/members/:memberId', {
      success: RosterPlayer,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: UpdatePlayerRequest,
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deactivateMember', '/teams/:teamId/members/:memberId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('reactivateMember', '/teams/:teamId/members/:memberId/reactivate', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listMemberRosters', '/teams/:teamId/members/:memberId/rosters', {
      success: Schema.Array(RosterInfo),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listRosters', '/teams/:teamId/rosters', {
      success: RosterListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createRoster', '/teams/:teamId/rosters', {
      success: RosterInfo.pipe(HttpApiSchema.status(201)),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: CreateRosterRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getRoster', '/teams/:teamId/rosters/:rosterId', {
      success: RosterDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateRoster', '/teams/:teamId/rosters/:rosterId', {
      success: RosterInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
        ChannelAlreadyLinked.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateRosterRequest,
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteRoster', '/teams/:teamId/rosters/:rosterId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('addRosterMember', '/teams/:teamId/rosters/:rosterId/members', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: AddRosterMemberRequest,
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'removeRosterMember',
      '/teams/:teamId/rosters/:rosterId/members/:memberId',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          RosterNotFound.pipe(HttpApiSchema.status(404)),
          PlayerNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, rosterId: RosterId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createChannel', '/teams/:teamId/rosters/:rosterId/channel', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('syncRoleMembers', '/teams/:teamId/rosters/:rosterId/sync-role-members', {
      success: SyncRoleMembersResult,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('backfillRosterRoles', '/teams/:teamId/rosters/backfill-role-members', {
      success: BackfillRosterRolesResult,
      error: [Forbidden.pipe(HttpApiSchema.status(403))],
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
