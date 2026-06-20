import { Auth, type Team } from '@sideline/domain';
import { Effect, type ServiceMap } from 'effect';
import { hasPermission, requirePermission, requireReadAccess } from '~/api/permissions.js';
import type { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

// ---------------------------------------------------------------------------
// Gate: requires member:edit on ALL endpoints.
// Resolves read access then additionally checks member:edit.
// Global admins bypass the permission check because VIEW_PERMISSIONS lacks member:edit.
// ---------------------------------------------------------------------------

export const requireManageAccess = <E>(
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamId: Team.TeamId,
  forbidden: E,
) =>
  Effect.Do.pipe(
    Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
    Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
    Effect.tap(({ currentUser, membership }) =>
      currentUser.isGlobalAdmin
        ? Effect.void
        : requirePermission(membership, 'member:edit', forbidden),
    ),
  );

// ---------------------------------------------------------------------------
// canManage helper — true when the current user has member:edit
// ---------------------------------------------------------------------------

export { hasPermission };
