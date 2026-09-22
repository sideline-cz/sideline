import { Effect } from 'effect';
import { profileGateEnabled } from '~/env.js';

// The profile gate for actions with a roster-integrity consequence (RSVP, training claim,
// carpool seat). `requiredByTeam` is the per-team opt-in (`team_settings.require_complete_profile`,
// DEFAULT false); `PROFILE_GATE_ENABLED` is the global incident lever and short-circuits it.
// Every call site already holds both booleans off a SELECT it was doing anyway, so this helper
// does no I/O and is a pure predicate over three booleans.
export const requireCompleteProfile = <E>(input: {
  readonly requiredByTeam: boolean;
  readonly isProfileComplete: boolean;
  readonly incomplete: E;
}): Effect.Effect<void, E> =>
  !profileGateEnabled || !input.requiredByTeam || input.isProfileComplete
    ? Effect.void
    : Effect.fail(input.incomplete).pipe(
        Effect.tapError(() => Effect.logInfo('Action blocked: profile incomplete')),
      );
