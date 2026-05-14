import { Auth } from '@sideline/domain';
import { Effect } from 'effect';

/**
 * Reads the current user from context and fails with the provided `forbidden`
 * error value if the user is not a global admin.
 */
export const requireGlobalAdmin = <E>(
  forbidden: E,
): Effect.Effect<void, E, Auth.CurrentUserContext> =>
  Auth.CurrentUserContext.asEffect().pipe(
    Effect.flatMap((currentUser) =>
      currentUser.isGlobalAdmin ? Effect.void : Effect.fail(forbidden),
    ),
  );
