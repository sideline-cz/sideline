import { Auth, type Role, type Team, TeamMember } from '@sideline/domain';
import { Array, Effect, Option, pipe, Schema, type ServiceMap } from 'effect';
import {
  MembershipWithRole,
  type TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';

export const requireMembership = <E>(
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamId: Team.TeamId,
  userId: Auth.UserId,
  forbidden: E,
) =>
  members.findMembershipByIds(teamId, userId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(forbidden).pipe(
            Effect.tapError(() =>
              Effect.logWarning(`Denied access for user ${userId} to team ${teamId}`),
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

export const VIEW_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'member:view',
  'role:view',
  'finance:view',
];

// Sentinel id for synthetic global-admin membership — only used when the admin is not a real
// team member. Handlers using requireReadAccess must NOT scope DB queries by membership.id.
export const GLOBAL_ADMIN_SENTINEL_ID = Schema.decodeSync(TeamMember.TeamMemberId)(
  '00000000-0000-0000-0000-000000000000',
);

export const requireReadAccess = <E>(
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamId: Team.TeamId,
  forbidden: E,
): Effect.Effect<MembershipWithRole, E, Auth.CurrentUserContext> =>
  Auth.CurrentUserContext.asEffect().pipe(
    Effect.flatMap((currentUser) =>
      members.findMembershipByIds(teamId, currentUser.id).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (membership) =>
              Effect.succeed(
                currentUser.isGlobalAdmin
                  ? new MembershipWithRole({
                      ...membership,
                      permissions: Array.dedupe([...membership.permissions, ...VIEW_PERMISSIONS]),
                    })
                  : membership,
              ),
            onNone: () =>
              currentUser.isGlobalAdmin
                ? Effect.succeed(
                    new MembershipWithRole({
                      id: GLOBAL_ADMIN_SENTINEL_ID,
                      team_id: teamId,
                      user_id: currentUser.id,
                      active: true,
                      role_names: ['Global Admin'],
                      permissions: VIEW_PERMISSIONS,
                    }),
                  )
                : Effect.fail(forbidden).pipe(
                    Effect.tapError(() =>
                      Effect.logWarning(
                        `Denied access for user ${currentUser.id} to team ${teamId}`,
                      ),
                    ),
                  ),
          }),
        ),
      ),
    ),
  );

export const hasPermission = (
  membership: MembershipWithRole,
  permission: Role.Permission,
): boolean => pipe(membership.permissions, Array.contains(permission));

export const requirePermission = <E>(
  membership: MembershipWithRole,
  permission: Role.Permission,
  forbidden: E,
) =>
  pipe(membership.permissions, Array.contains(permission))
    ? Effect.void
    : Effect.fail(forbidden).pipe(
        Effect.tapError(() =>
          Effect.logWarning(
            `Denied permission ${permission} for user ${membership.user_id} to team ${membership.team_id}`,
          ),
        ),
      );
