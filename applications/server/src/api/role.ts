import { Auth, RoleApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import {
  hasPermission,
  requireMembership,
  requirePermission,
  requireReadAccess,
} from '~/api/permissions.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new RoleApi.Forbidden();

// F1 fix (review): the ONLY reason this warning does not block privilege escalation server-side
// is that `role:manage` is already total escalation on its own — a holder can immediately
// `setRolePermissions(playerRoleId, ['team:manage'])` regardless of what the default role grants
// today. So the warning must fire for `role:manage` itself, not just `team:manage`. `member:remove`
// joins the set for the same reason: a joiner who can remove members can unilaterally strip every
// other admin/captain from the roster. These three are the ones that let a brand-new joiner seize
// or irreversibly damage the team; the rest of the Captain permission set (`event:cancel`,
// `roster:manage`, etc.) is a legitimate default for a small club and would just be noise here.
const DEFAULT_ROLE_ESCALATION_PERMISSIONS: ReadonlyArray<string> = [
  'team:manage',
  'role:manage',
  'member:remove',
];

export const RoleApiLive = HttpApiBuilder.group(Api, 'role', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('notifications', () => NotificationsRepository.asEffect()),
    Effect.map(({ members, roles, notifications }) =>
      handlers
        .handle('listRoles', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:view', forbidden)),
            Effect.let('canManage', ({ membership }) => hasPermission(membership, 'role:manage')),
            Effect.bind('roleList', () => roles.findRolesByTeamId(teamId)),
            // THE shared resolve expression — same call the three join paths make. Do NOT
            // reimplement "is_default OR built-in Player" here; that is the drift this contract
            // exists to prevent.
            Effect.bind('defaultRole', () => members.getDefaultRoleId(teamId)),
            Effect.bind('defaultPermissions', ({ defaultRole }) =>
              Option.match(defaultRole, {
                onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
                onSome: (r) => roles.getPermissionsForRoleId(r.id),
              }),
            ),
            Effect.map(
              ({ roleList, canManage, defaultRole, defaultPermissions }) =>
                new RoleApi.RoleListResponse({
                  canManage,
                  roles: Array.map(
                    roleList,
                    (r) =>
                      new RoleApi.RoleInfo({
                        roleId: r.id,
                        teamId: teamId,
                        name: r.name,
                        isBuiltIn: r.is_built_in,
                        permissionCount: r.permission_count,
                      }),
                  ),
                  defaultRoleId: Option.map(defaultRole, (r) => r.id),
                  defaultRoleGrantsManage: defaultPermissions.some((p) =>
                    DEFAULT_ROLE_ESCALATION_PERMISSIONS.includes(p),
                  ),
                }),
            ),
          ),
        )
        .handle('createRole', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('role', () => roles.insertRole(teamId, payload.name)),
            Effect.tap(({ role }) => roles.setRolePermissions(role.id, payload.permissions)),
            Effect.map(
              ({ role }) =>
                new RoleApi.RoleDetail({
                  roleId: role.id,
                  teamId: teamId,
                  name: role.name,
                  isBuiltIn: role.is_built_in,
                  permissions: [...payload.permissions],
                  canManage: true,
                  // A freshly created role is never the default.
                  isDefaultForNewMembers: false,
                }),
            ),
            Effect.catchTag('RoleNameAlreadyTakenError', () =>
              Effect.fail(new RoleApi.RoleNameAlreadyTaken()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(
                () => `Failed creating role "${payload.name}" — no row returned`,
              ),
            ),
          ),
        )
        .handle('getRole', ({ params: { teamId, roleId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:view', forbidden)),
            Effect.let('canManage', ({ membership }) => hasPermission(membership, 'role:manage')),
            Effect.bind('role', () =>
              roles.findRoleById(roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // `findRoleById` has no team filter, so a role id from ANOTHER team resolves here
            // and would otherwise be read/modified by an admin of this one. Same guard as
            // `assignRoleToMember`/`unassignRole` below. `RoleNotFound`, not `Forbidden`: a foreign
            // role's existence is not this team's business.
            Effect.tap(({ role }) =>
              role.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.bind('permissions', ({ role }) => roles.getPermissionsForRoleId(role.id)),
            Effect.bind('defaultRole', () => members.getDefaultRoleId(teamId)),
            Effect.map(
              ({ role, permissions, canManage, defaultRole }) =>
                new RoleApi.RoleDetail({
                  roleId: role.id,
                  teamId: teamId,
                  name: role.name,
                  isBuiltIn: role.is_built_in,
                  permissions: [...permissions],
                  canManage,
                  isDefaultForNewMembers: Option.match(defaultRole, {
                    onNone: () => false,
                    onSome: (d) => d.id === role.id,
                  }),
                }),
            ),
          ),
        )
        .handle('updateRole', ({ params: { teamId, roleId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('existing', () =>
              roles.findRoleById(roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // `findRoleById` has no team filter, so a role id from ANOTHER team resolves here
            // and would otherwise be read/modified by an admin of this one. Same guard as
            // `assignRoleToMember`/`unassignRole` below. `RoleNotFound`, not `Forbidden`: a foreign
            // role's existence is not this team's business.
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              existing.is_built_in && Option.isSome(payload.name)
                ? Effect.fail(new RoleApi.CannotModifyBuiltIn())
                : Effect.void,
            ),
            Effect.bind('updated', ({ existing }) =>
              Option.match(payload.name, {
                onNone: () => Effect.succeed(existing),
                onSome: (name) => roles.updateRole(roleId, Option.some(name)),
              }),
            ),
            Effect.tap(() =>
              Option.match(payload.permissions, {
                onNone: () => Effect.void,
                onSome: (perms) => roles.setRolePermissions(roleId, perms),
              }),
            ),
            Effect.bind('permissions', () => roles.getPermissionsForRoleId(roleId)),
            // Renaming a role does not change which one is default — resolve rather than report
            // `false`, or the detail page would flicker on an unrelated update.
            Effect.bind('defaultRole', () => members.getDefaultRoleId(teamId)),
            Effect.map(
              ({ updated, permissions, defaultRole }) =>
                new RoleApi.RoleDetail({
                  roleId: updated.id,
                  teamId: teamId,
                  name: updated.name,
                  isBuiltIn: updated.is_built_in,
                  permissions: [...permissions],
                  canManage: true,
                  isDefaultForNewMembers: Option.match(defaultRole, {
                    onNone: () => false,
                    onSome: (d) => d.id === updated.id,
                  }),
                }),
            ),
            Effect.catchTag('RoleNameAlreadyTakenError', () =>
              Effect.fail(new RoleApi.RoleNameAlreadyTaken()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => `Failed updating role ${roleId} — no row returned`),
            ),
          ),
        )
        .handle('deleteRole', ({ params: { teamId, roleId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('existing', () =>
              roles.findRoleById(roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // `findRoleById` has no team filter, so a role id from ANOTHER team resolves here
            // and would otherwise be read/modified by an admin of this one. Same guard as
            // `assignRoleToMember`/`unassignRole` below. `RoleNotFound`, not `Forbidden`: a foreign
            // role's existence is not this team's business.
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              existing.is_built_in ? Effect.fail(new RoleApi.CannotModifyBuiltIn()) : Effect.void,
            ),
            Effect.bind('memberCount', () => roles.getMemberCountForRole(roleId)),
            Effect.tap(({ memberCount }) =>
              memberCount > 0 ? Effect.fail(new RoleApi.RoleInUse()) : Effect.void,
            ),
            Effect.tap(() => roles.archiveRoleById(roleId)),
            Effect.asVoid,
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => `Failed deleting role ${roleId} — no row returned`),
            ),
          ),
        )
        .handle('assignRole', ({ params: { teamId, memberId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('targetMember', () =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.MemberNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.bind('role', () =>
              roles.findRoleById(payload.roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ role }) =>
              role.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.tap(() => members.assignRole(memberId, payload.roleId)),
            Effect.tap(({ targetMember, role }) =>
              notifications
                .insert(
                  teamId,
                  targetMember.user_id,
                  'role_assigned',
                  `Role "${role.name}" assigned`,
                  `You have been assigned the "${role.name}" role.`,
                )
                .pipe(
                  Effect.tapError((e) =>
                    Effect.logWarning('Failed to create role-assigned notification', e),
                  ),
                  Effect.catchTag('NoSuchElementError', () => Effect.void),
                ),
            ),
            Effect.asVoid,
          ),
        )
        .handle('unassignRole', ({ params: { teamId, memberId, roleId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('targetMember', () =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.MemberNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.bind('role', () =>
              roles.findRoleById(roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ role }) =>
              role.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.tap(() => members.unassignRole(memberId, roleId)),
            // Guard (fix/role-linking): the DELETE above only removes the DIRECT
            // `member_roles` row. A member who ALSO holds this role through a group
            // (`group_members` → group ancestry → `role_groups`) still effectively holds
            // it afterwards — deleting the direct grant alone did not revoke anything,
            // so the "role removed" notification should not fire. Re-check the
            // effective set AFTER the delete and skip it when the role is still held.
            // A member holding it directly only (the common case) has nothing left
            // after the delete, so this still emits.
            //
            // `findEffectiveRoleIdsForMember` pipes `catchSqlErrors`, which turns a
            // `SqlError` into a `LogicError` DEFECT, not a typed failure — a plain
            // `Effect.bind` here would let a DB blip on this read-only re-check 500 the
            // whole request even though `unassignRole` above already committed.
            // Degrade to the pre-guard behaviour — treat the role as no-longer-held
            // (so the notification still fires) — on any defect from the re-check,
            // logging it for visibility.
            Effect.bind('stillHeldEffectively', ({ targetMember }) =>
              members.findEffectiveRoleIdsForMember(targetMember.member_id).pipe(
                Effect.map((rows) => rows.some((row) => row.role_id === roleId)),
                Effect.catchDefect((defect) =>
                  Effect.logWarning(
                    'unassignRole: failed re-checking effective roles after delete — treating as not-still-held',
                    defect,
                  ).pipe(Effect.as(false)),
                ),
              ),
            ),
            Effect.tap(({ targetMember, role, stillHeldEffectively }) =>
              stillHeldEffectively
                ? Effect.void
                : notifications
                    .insert(
                      teamId,
                      targetMember.user_id,
                      'role_removed',
                      `Role "${role.name}" removed`,
                      `You have been removed from the "${role.name}" role.`,
                    )
                    .pipe(
                      Effect.catchTag('NoSuchElementError', (e) =>
                        Effect.logWarning('Failed to create role-removed notification', e),
                      ),
                    ),
            ),
            Effect.asVoid,
          ),
        )
        .handle('setDefaultRole', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:manage', forbidden)),
            Effect.bind('role', () =>
              roles.findRoleById(payload.roleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RoleApi.RoleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // BLOCKER 2 fix 1 — same guard as `assignRoleToMember` (:249). `findRoleById` has no
            // team filter, so without this a roleId from another team lands here.
            Effect.tap(({ role }) =>
              role.team_id !== teamId ? Effect.fail(new RoleApi.RoleNotFound()) : Effect.void,
            ),
            Effect.tap(({ role }) => roles.setDefaultRole(role.id)),
            // No audit trail exists to write to — see "Escalation is silent" in the plan.
            Effect.tap(({ role }) =>
              Effect.logInfo('[role/setDefaultRole] default role changed', {
                teamId,
                roleId: role.id,
              }),
            ),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
