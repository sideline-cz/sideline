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
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { syncMemberDiscordRoles } from '~/utils/syncMemberDiscordRoles.js';

const forbidden = new RoleApi.Forbidden();

export const RoleApiLive = HttpApiBuilder.group(Api, 'role', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('notifications', () => NotificationsRepository.asEffect()),
    Effect.bind('roleSyncEvents', () => RoleSyncEventsRepository.asEffect()),
    Effect.map(({ members, roles, notifications, roleSyncEvents }) =>
      handlers
        .handle('listRoles', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) => requirePermission(membership, 'role:view', forbidden)),
            Effect.let('canManage', ({ membership }) => hasPermission(membership, 'role:manage')),
            Effect.bind('roleList', () => roles.findRolesByTeamId(teamId)),
            Effect.map(
              ({ roleList, canManage }) =>
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
            // Root cause D: enqueue the Discord sync event. Best-effort tap — a sync-queue write
            // must never fail the captain's actual role creation (AGENTS.md error-handling rule 6).
            Effect.tap(({ role }) =>
              roleSyncEvents
                .emitRoleCreated(teamId, role.id, role.name)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning('Failed to emit role_created sync event', cause),
                  ),
                ),
            ),
            Effect.map(
              ({ role }) =>
                new RoleApi.RoleDetail({
                  roleId: role.id,
                  teamId: teamId,
                  name: role.name,
                  isBuiltIn: role.is_built_in,
                  permissions: [...payload.permissions],
                  canManage: true,
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
            Effect.bind('permissions', ({ role }) => roles.getPermissionsForRoleId(role.id)),
            Effect.map(
              ({ role, permissions, canManage }) =>
                new RoleApi.RoleDetail({
                  roleId: role.id,
                  teamId: teamId,
                  name: role.name,
                  isBuiltIn: role.is_built_in,
                  permissions: [...permissions],
                  canManage,
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
            Effect.map(
              ({ updated, permissions }) =>
                new RoleApi.RoleDetail({
                  roleId: updated.id,
                  teamId: teamId,
                  name: updated.name,
                  isBuiltIn: updated.is_built_in,
                  permissions: [...permissions],
                  canManage: true,
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
            Effect.tap(({ existing }) =>
              existing.is_built_in ? Effect.fail(new RoleApi.CannotModifyBuiltIn()) : Effect.void,
            ),
            Effect.bind('memberCount', () => roles.getMemberCountForRole(roleId)),
            Effect.tap(({ memberCount }) =>
              memberCount > 0 ? Effect.fail(new RoleApi.RoleInUse()) : Effect.void,
            ),
            Effect.tap(() => roles.archiveRoleById(roleId)),
            // Root cause D: enqueue the Discord sync event, using the name captured in `existing`
            // BEFORE archiving. Best-effort tap — never fails the captain's delete.
            Effect.tap(({ existing }) =>
              roleSyncEvents
                .emitRoleDeleted(teamId, roleId, existing.name)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning('Failed to emit role_deleted sync event', cause),
                  ),
                ),
            ),
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
            // Root cause D: enqueue the Discord sync event. Best-effort tap — a sync-queue write
            // must never fail the captain's actual role assignment (AGENTS.md error-handling rule 6).
            // Skipped when the member has no discord_id — nothing to propagate to Discord.
            Effect.tap(({ targetMember, role }) =>
              targetMember.discord_id
                ? roleSyncEvents
                    .emitRoleAssigned(
                      teamId,
                      role.id,
                      role.name,
                      targetMember.member_id,
                      targetMember.discord_id,
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning('Failed to emit role_assigned sync event', cause),
                      ),
                    )
                : Effect.void,
            ),
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
            // Root cause D: enqueue the Discord sync event. Best-effort tap — a sync-queue write
            // must never fail the captain's actual role removal (AGENTS.md error-handling rule 6).
            // Skipped when the member has no discord_id — nothing to propagate to Discord.
            Effect.tap(({ targetMember, role }) =>
              targetMember.discord_id
                ? roleSyncEvents
                    .emitRoleUnassigned(
                      teamId,
                      role.id,
                      role.name,
                      targetMember.member_id,
                      targetMember.discord_id,
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning('Failed to emit role_unassigned sync event', cause),
                      ),
                    )
                : Effect.void,
            ),
            Effect.tap(({ targetMember, role }) =>
              notifications
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
        .handle('syncMemberDiscordRoles', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            // Blocker C (whole-series review): `role:manage` is Admin-only (not even Captain
            // holds it), but the web renders the sync button to every member. Self-serve
            // carve-out — a member re-syncing THEIR OWN roles is always allowed; syncing anyone
            // else still requires `role:manage`.
            Effect.tap(({ membership }) =>
              membership.id === memberId
                ? Effect.void
                : requirePermission(membership, 'role:manage', forbidden),
            ),
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
            Effect.flatMap(() => syncMemberDiscordRoles(teamId, memberId)),
          ),
        ),
    ),
  ),
);
