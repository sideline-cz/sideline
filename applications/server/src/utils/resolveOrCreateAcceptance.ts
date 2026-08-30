import type { InviteAcceptance, TeamInvite, User } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';

const RATE_LIMIT_PER_HOUR = 3;

export interface ResolveOrCreateAcceptanceResult {
  readonly acceptance: InviteAcceptance.InviteAcceptance;
  readonly created: boolean;
  readonly rateLimited: boolean;
}

/**
 * CC-14's regenerate primitive: the single code path allowed to call
 * `InviteAcceptancesRepository.create` after PR-4. It is the idempotent re-join AND the
 * regenerate-invite endpoint (PR-5 imports this unchanged).
 *
 * - An "open" acceptance (no terminal error code, and — if a code was already minted — the
 *   code has not expired) is reused as-is; nothing is created.
 * - Otherwise, a new acceptance is minted UNLESS the caller has hit the 3/hour rate limit
 *   FOR THIS INVITE (BLOCKER 1, third review of PR-4 — the count is scoped to the (user,
 *   invite) pair, not every invite the user has ever touched).
 *   - When rate-limited, the newest row for this (user, invite) pair is returned unchanged so
 *     the UI keeps showing its current state without minting a second one-time Discord invite.
 *     Because the rate limit is now scoped to the same pair the count query used, hitting the
 *     cap PROVES at least one row already exists for this pair — `findNewestByUserAndInvite`
 *     returning `None` here would mean the count and the lookup disagree about what exists,
 *     which is an invariant violation, not a legitimate state. It surfaces as a defect
 *     (`LogicError.die`) rather than silently returning no acceptance (the pre-fix "fails
 *     closed" bug), so `acceptance` never needs to be `Option` downstream.
 */
export const resolveOrCreateAcceptance = (
  userId: User.UserId,
  invite: { readonly id: TeamInvite.TeamInviteId },
) =>
  Effect.Do.pipe(
    Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
    Effect.bind('open', ({ acceptances }) =>
      acceptances.findOpenByUserAndInvite(userId, invite.id),
    ),
    Effect.flatMap(({ acceptances, open }) =>
      Option.match(open, {
        onSome: (acceptance) =>
          Effect.succeed<ResolveOrCreateAcceptanceResult>({
            acceptance,
            created: false,
            rateLimited: false,
          }),
        onNone: () =>
          acceptances.countRecentByUserAndInvite(userId, invite.id).pipe(
            Effect.flatMap((recentCount) =>
              recentCount >= RATE_LIMIT_PER_HOUR
                ? acceptances.findNewestByUserAndInvite(userId, invite.id).pipe(
                    Effect.flatMap(
                      Option.match({
                        // Unreachable given the count query above is scoped to the same
                        // (user, invite) pair — see the doc comment. Fails loudly rather than
                        // reintroducing the "no acceptance returned" bug this replaces.
                        onNone: () =>
                          LogicError.die(
                            '[resolveOrCreateAcceptance] rate limit hit but no acceptance exists for this (user, invite) pair — count and lookup disagree',
                            { userId, teamInviteId: invite.id },
                          ),
                        onSome: (acceptance) =>
                          Effect.logInfo(
                            '[resolveOrCreateAcceptance] rate limit hit — reusing newest acceptance instead of creating',
                            { userId, teamInviteId: invite.id },
                          ).pipe(
                            Effect.as<ResolveOrCreateAcceptanceResult>({
                              acceptance,
                              created: false,
                              rateLimited: true,
                            }),
                          ),
                      }),
                    ),
                  )
                : acceptances.create({ team_invite_id: invite.id, user_id: userId }).pipe(
                    Effect.map(
                      (acceptance): ResolveOrCreateAcceptanceResult => ({
                        acceptance,
                        created: true,
                        rateLimited: false,
                      }),
                    ),
                  ),
            ),
          ),
      }),
    ),
  );
