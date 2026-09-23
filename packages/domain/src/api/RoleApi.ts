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
  // RESOLVED server-side by `TeamMembersRepository.getDefaultRoleId` — the same expression the
  // three join paths use, including its built-in-Player fallback. NOT the raw `roles.is_default`
  // column: a team that never configured a default still SEEDS built-in Player on every join, and
  // a raw boolean would report `false` for every row and render an empty control.
  // `None` therefore means "new members get NO role" — which also means every invite link is
  // currently failing with `InviteNotFound` (see `api/invite.ts`).
  //
  // Both new fields decode tolerantly (`withDecodingDefaultKey`) for the reason on
  // `TeamSettingsApi.ts:92`: web bundles a FROZEN copy of this schema, so a new bundle served by a
  // server that predates them must not take the whole roles page down.
  //
  // Plain `//`, not JSDoc — the barrel codegen hoists a module's first JSDoc block onto its
  // `export * as` line in `index.ts`.
  defaultRoleId: Schema.OptionFromNullOr(RoleId).pipe(Schema.withDecodingDefaultKey(() => null)),
  // True when the resolved default role holds `team:manage`. Lives on the LIST response because
  // that is where the control lives — the warning belongs next to the control that causes it.
  defaultRoleGrantsManage: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
}) {}

export class RoleDetail extends Schema.Class<RoleDetail>('RoleDetail')({
  roleId: RoleId,
  teamId: TeamId,
  name: Schema.String,
  isBuiltIn: Schema.Boolean,
  permissions: Schema.Array(Permission),
  canManage: Schema.Boolean,
  // RESOLVED, not raw: true when THIS role is the one a new member would receive, fallback
  // included. Read-only on the detail page — the control lives on the list page.
  isDefaultForNewMembers: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
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

// `[r3]` NON-OPTIONAL. The UI has no path to send "none": the "No role" entry renders only when it
// is already the current value (the genuinely broken no-`is_default`-and-no-`Player` state) and is
// never a selectable target, and choosing `Player` from the list already expresses "fall back to
// Player" with a byte-identical outcome. A second option meaning the same thing is a duplicate.
//
// Widening path if an explicit clear affordance is ever added: `Schema.OptionFromOptional(RoleId)`
// — NOT `OptionFromNullOr`, so a bundle predating the affordance keeps decoding. It would also
// need its own confirm dialog: clearing can break every invite link.
export const SetDefaultRoleRequest = Schema.Struct({
  roleId: RoleId,
});
export type SetDefaultRoleRequest = Schema.Schema.Type<typeof SetDefaultRoleRequest>;

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
    HttpApiEndpoint.put('setDefaultRole', '/teams/:teamId/default-role', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RoleNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: SetDefaultRoleRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
