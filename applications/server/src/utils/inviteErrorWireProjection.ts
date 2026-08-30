import type { Invite, Onboarding } from '@sideline/domain';
import { Option } from 'effect';

/**
 * Projects the STORED `Onboarding.InviteGeneratorErrorCode` (10 literals, decoded by the server
 * and the bot — see that model's doc comment) onto the client-facing `Invite.JoinStatusErrorCode`
 * (the original 8), applied at the `getJoinStatus` read boundary (CC-3).
 *
 * `'expired'` collapses to `None` PERMANENTLY: expiry is carried by `JoinStatus.state`
 * (added in PR-5), never by `errorCode` — not in PR-5, not in PR-9, not ever. `'bot_not_in_guild'`
 * projects to `'unknown'` until PR-9 adds it to the client-facing union and deletes that mapping.
 * Everything else is identity.
 *
 * Model: `applications/server/src/utils/rsvpWireProjection.ts`.
 */
export const projectInviteErrorToWire = (
  code: Onboarding.InviteGeneratorErrorCode,
): Option.Option<Invite.JoinStatusErrorCode> =>
  code === 'expired'
    ? Option.none() // permanent: `state` says it (CC-3)
    : code === 'bot_not_in_guild'
      ? Option.some('unknown') // removed in PR-9
      : Option.some(code);
