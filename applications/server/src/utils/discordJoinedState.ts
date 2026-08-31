import type { Auth } from '@sideline/domain';
import { Option } from 'effect';

/**
 * PR-9 / CC-15 — the tri-state gate. Pure function of the two PR-8 columns so the anti-lockout
 * rule (designer §3.6 step 2) is independently testable without standing up `auth.myTeams`'s
 * full handler: **a guild whose member list was never provably read completely must never be
 * interpreted as "nobody is connected"**. `discordJoined` wins over "backfilled" — a member
 * observed joined is `'connected'` even if the guild's backfill technically raced it.
 *
 * - `discordJoinedAt` is `Some` → `'connected'`.
 * - `discordJoinedAt` is `None` AND `membersBackfilledAt` is `Some` → `'not_connected'`.
 * - Otherwise (both `None`) → `'unknown'`.
 */
export const deriveDiscordJoined = (
  discordJoinedAt: Option.Option<unknown>,
  membersBackfilledAt: Option.Option<unknown>,
): Auth.UserTeamDiscordJoined =>
  Option.isSome(discordJoinedAt)
    ? 'connected'
    : Option.isSome(membersBackfilledAt)
      ? 'not_connected'
      : 'unknown';
