import type { Invite, InviteAcceptance } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { projectInviteErrorToWire } from '~/utils/inviteErrorWireProjection.js';
import { INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS } from '~/utils/inviteExpiry.js';

export interface JoinStatusStateResult {
  readonly state: Invite.JoinStatusState;
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<Invite.JoinStatusErrorCode>;
}

/**
 * PR-5 step 6 — the one `state` helper, shared by `getJoinStatus`, `getMyPendingDiscordJoin`
 * and `regenerateMyDiscordInvite` (`applications/server/src/api/invite.ts`). Pure function of
 * an `invite_acceptances` row; no I/O.
 *
 * Precedence, in order:
 * 1. `discord_code` present → `'ready'`. This wins over everything — CC-6/S2: a failed
 *    `pending_guild_joins` row (auto-join) is not surfaced here, and a leftover
 *    `discord_code_error_code` from an earlier attempt on the same row does not matter once a
 *    working code exists.
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
    'discord_code' | 'discord_code_error_code' | 'created_at'
  >,
): JoinStatusStateResult => {
  if (Option.isSome(acceptance.discord_code)) {
    return {
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
