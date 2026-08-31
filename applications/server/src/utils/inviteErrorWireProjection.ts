import type { Invite, Onboarding } from '@sideline/domain';
import { Option } from 'effect';

/**
 * Projects the STORED `Onboarding.InviteGeneratorErrorCode` (10 literals, decoded by the server
 * and the bot — see that model's doc comment) onto the client-facing `Invite.JoinStatusErrorCode`
 * (PR-9: 9 literals, now that `'bot_not_in_guild'` has joined it), applied at the `getJoinStatus`
 * read boundary (CC-3).
 *
 * `'expired'` collapses to `None` PERMANENTLY: expiry is carried by `JoinStatus.state`
 * (added in PR-5), never by `errorCode` — not in PR-5, not in PR-9, not ever. This is the only
 * remaining non-identity mapping — PR-9 deletes the `'bot_not_in_guild' → 'unknown'` mapping now
 * that the client-facing union carries the real code. Keep this file and the `'expired'`
 * collapse; do not delete the projection entirely (rev 2 got this wrong).
 *
 * Model: `applications/server/src/utils/rsvpWireProjection.ts`.
 */
export const projectInviteErrorToWire = (
  code: Onboarding.InviteGeneratorErrorCode,
): Option.Option<Invite.JoinStatusErrorCode> =>
  code === 'expired'
    ? Option.none() // permanent: `state` says it (CC-3)
    : Option.some(code);
