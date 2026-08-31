import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Permission, RoleId } from '~/models/Role.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class RoleInfo extends Schema.Class<RoleInfo>('RoleInfo')({
  roleId: RoleId,
  teamId: TeamId,
  name: Schema.String,
  isBuiltIn: Schema.Boolean,
  permissionCount: Schema.Number,
}) {}

export class RoleListResponse extends Schema.Class<RoleListResponse>('RoleListResponse')({
  canManage: Schema.Boolean,
  roles: Schema.Array(RoleInfo),
}) {}

export class RoleDetail extends Schema.Class<RoleDetail>('RoleDetail')({
  roleId: RoleId,
  teamId: TeamId,
  name: Schema.String,
  isBuiltIn: Schema.Boolean,
  permissions: Schema.Array(Permission),
  canManage: Schema.Boolean,
}) {}

export const CreateRoleRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  permissions: Schema.Array(Permission),
});
export type CreateRoleRequest = Schema.Schema.Type<typeof CreateRoleRequest>;

export const UpdateRoleRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(Schema.NonEmptyString),
  permissions: Schema.OptionFromNullOr(Schema.Array(Permission)),
});
export type UpdateRoleRequest = Schema.Schema.Type<typeof UpdateRoleRequest>;

export class RoleNotFound extends Schema.TaggedErrorClass<RoleNotFound>()('RoleNotFound', {}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('RoleForbidden', {}) {}

export class CannotModifyBuiltIn extends Schema.TaggedErrorClass<CannotModifyBuiltIn>()(
  'CannotModifyBuiltIn',
  {},
) {}

export const AssignRoleRequest = Schema.Struct({
  roleId: RoleId,
});
export type AssignRoleRequest = Schema.Schema.Type<typeof AssignRoleRequest>;

export class MemberNotFound extends Schema.TaggedErrorClass<MemberNotFound>()(
  'MemberNotFound',
  {},
) {}

export class RoleInUse extends Schema.TaggedErrorClass<RoleInUse>()('RoleInUse', {}) {}

export class RoleNameAlreadyTaken extends Schema.TaggedErrorClass<RoleNameAlreadyTaken>()(
  'RoleNameAlreadyTaken',
  {},
) {}

// Four buckets, not nine (CC-8) — collapse to a distinct remedy per code:
// `retryable` (we will retry; nothing for the captain to do), `captain_action` (bot missing
// permission, role hierarchy, guild not configured), `user_action` (not in the guild / left the
// guild), `unknown` (fallback). Expand only when a new code implies a distinct remedy.
export const DiscordSyncErrorCode = Schema.Literals([
  'retryable',
  'captain_action',
  'user_action',
  'unknown',
]);
export type DiscordSyncErrorCode = Schema.Schema.Type<typeof DiscordSyncErrorCode>;

// Final shape shipped once in PR-7 (CC-8) — PR-8/PR-9 populate `roleSyncState` and the two
// `last*` fields without touching this DTO, its copy, or its i18n keys. In PR-7 `roleSyncState`
// is always `'queued'` (or `'never'` when the member has no `discord_id`) and both `last*`
// fields are `Option.none()`.
export class SyncMemberRolesResult extends Schema.Class<SyncMemberRolesResult>(
  'SyncMemberRolesResult',
)({
  addedCount: Schema.Number,
  removedCount: Schema.Number,
  skippedCount: Schema.Number,
  roleSyncState: Schema.Literals(['queued', 'ok', 'failed', 'never']),
  lastRoleSyncAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  lastRoleSyncError: Schema.OptionFromNullOr(DiscordSyncErrorCode),
}) {}

export class RoleApiGroup extends HttpApiGroup.make('role')
  .add(
    HttpApiEndpoint.get('listRoles', '/teams/:teamId/roles', {
      success: RoleListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createRole', '/teams/:teamId/roles', {
      success: RoleDetail.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RoleNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateRoleRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getRole', '/teams/:teamId/roles/:roleId', {
      success: RoleDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, roleId: RoleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateRole', '/teams/:teamId/roles/:roleId', {
      success: RoleDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
        CannotModifyBuiltIn.pipe(HttpApiSchema.status(400)),
        RoleNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateRoleRequest,
      params: { teamId: TeamId, roleId: RoleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteRole', '/teams/:teamId/roles/:roleId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
        CannotModifyBuiltIn.pipe(HttpApiSchema.status(400)),
        RoleInUse.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, roleId: RoleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('assignRole', '/teams/:teamId/members/:memberId/roles', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        MemberNotFound.pipe(HttpApiSchema.status(404)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: AssignRoleRequest,
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('unassignRole', '/teams/:teamId/members/:memberId/roles/:roleId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        MemberNotFound.pipe(HttpApiSchema.status(404)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId, roleId: RoleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'syncMemberDiscordRoles',
      '/teams/:teamId/members/:memberId/sync-discord-roles',
      {
        success: SyncMemberRolesResult,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          MemberNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  ) {}
