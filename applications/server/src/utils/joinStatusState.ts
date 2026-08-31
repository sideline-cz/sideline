import type { Invite, InviteAcceptance } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { projectInviteErrorToWire } from '~/utils/inviteErrorWireProjection.js';
import {
  DISCORD_CODE_MAX_AGE_HOURS,
  INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS,
} from '~/utils/inviteExpiry.js';

// Should-fix 4 (whole-series review of commit 46806427): a `discord_code` is only usable while
// the bot's one-time invite (`max_age: 86400`, see `DISCORD_CODE_MAX_AGE_HOURS`) can still work.
// This used to be a SQL `WHERE` clause on `InviteAcceptancesRepository.findOpenByUserAndTeam`
// that filtered a stale-code row out of the query result entirely — the caller then saw `None`
// and rendered generic "No invite available" instead of the `'expired'` state this union already
// has dedicated copy for (CC-3). Moved here so `deriveJoinStatusState` is the one place that
// decides, matching the same "the SQL should not decide, this function should" principle the
// `discord_code_error_code IS NULL` predicate was already removed for. `generated_at` is `None`
// only for a row that has never had a code minted at all — that combination never coexists with a
// present `discord_code` (both are always written together, see `setDiscordCode`), so `false`
// here is a defensive default, not a real code path.
const isStaleDiscordCode = (generatedAt: Option.Option<Date>): boolean =>
  Option.match(generatedAt, {
    onNone: () => false,
    onSome: (date) =>
      DateTime.isLessThan(
        DateTime.fromDateUnsafe(date),
        DateTime.subtract(DateTime.nowUnsafe(), { hours: DISCORD_CODE_MAX_AGE_HOURS }),
      ),
  });

export interface JoinStatusStateResult {
  readonly state: Invite.JoinStatusState;
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<Invite.JoinStatusErrorCode>;
}

/**
 * PR-5 step 6 — the one `state` helper, shared by `getJoinStatus`, `getMyPendingDiscordJoin`
 * and `regenerateMyDiscordInvite` (`applications/server/src/api/invite.ts`). Pure function of
 * an `invite_acceptances` row (plus, as of PR-9, the caller's `discord_joined_at` observation);
 * no I/O.
 *
 * Precedence, in order:
 * 0. `discordJoined` (PR-9 / CC-15) → `'joined'`, `discordInviteUrl`/`errorCode` both `None`.
 *    This wins over EVERYTHING else: `team_members.discord_joined_at` is the only source that
 *    is *cleared* when a user leaves the guild, so a user who is factually in the guild is
 *    `'joined'` regardless of what their invite acceptance row happens to say (a leftover error
 *    code from a since-irrelevant attempt, a code that is technically still live, etc.).
 * 1. `discord_code` present AND still usable (should-fix 4: `generated_at` within
 *    `DISCORD_CODE_MAX_AGE_HOURS`) → `'ready'`. This wins over everything else — CC-6/S2: a
 *    failed `pending_guild_joins` row (auto-join) is not surfaced here, and a leftover
 *    `discord_code_error_code` from an earlier attempt on the same row does not matter once a
 *    working code exists.
 * 1b. `discord_code` present but STALE (should-fix 4, whole-series review of commit 46806427)
 *    → `'expired'`, `errorCode: None`, same as 2 below. A dead one-time code is exactly the
 *    "generate me a fresh one" case, so it gets the same state and copy as any other expiry —
 *    see `isStaleDiscordCode`'s doc comment for why this moved here instead of staying a SQL
 *    filter that made the row disappear instead of being classified.
 * 2. `discord_code_error_code === 'expired'` → `'expired'`, `errorCode: None` — CC-3: expiry
 *    is carried by `state`, never by `errorCode`.
 * 3. Any other `discord_code_error_code` → `'failed'`, `errorCode` from the wire projection.
 * 4. Neither, and the row is older than the shared derived window → `'expired'`, WITHOUT
 *    writing anything (CC-4's defensive guard — the sweep is the writer, and its window is
 *    strictly smaller so it always gets there first).
 * 5. Otherwise → `'preparing'`.
 */
export const deriveJoinStatusState = (
  acceptance: Pick<
    InviteAcceptance.InviteAcceptance,
    'discord_code' | 'discord_code_error_code' | 'created_at' | 'generated_at'
  >,
  discordJoined = false,
): JoinStatusStateResult => {
  if (discordJoined) {
    return { state: 'joined', discordInviteUrl: Option.none(), errorCode: Option.none() };
  }

  if (Option.isSome(acceptance.discord_code)) {
    return isStaleDiscordCode(acceptance.generated_at)
      ? { state: 'expired', discordInviteUrl: Option.none(), errorCode: Option.none() }
      : {
          state: 'ready',
          discordInviteUrl: Option.some(`https://discord.gg/${acceptance.discord_code.value}`),
          errorCode: Option.none(),
        };
  }

  if (Option.isSome(acceptance.discord_code_error_code)) {
    const errorCode = acceptance.discord_code_error_code.value;
    return errorCode === 'expired'
      ? { state: 'expired', discordInviteUrl: Option.none(), errorCode: Option.none() }
      : {
          state: 'failed',
          discordInviteUrl: Option.none(),
          errorCode: projectInviteErrorToWire(errorCode),
        };
  }

  const derivedExpiryCutoff = DateTime.subtract(DateTime.nowUnsafe(), {
    days: INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS,
  });
  return DateTime.isLessThan(acceptance.created_at, derivedExpiryCutoff)
    ? { state: 'expired', discordInviteUrl: Option.none(), errorCode: Option.none() }
    : { state: 'preparing', discordInviteUrl: Option.none(), errorCode: Option.none() };
};
