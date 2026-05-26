import { Auth, type User } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { globalAdminDiscordIds } from '~/env.js';

/**
 * Builds an `Auth.CurrentUser` from a `User.User` row.
 *
 * `isGlobalAdmin` is `true` when either the DB flag is set (`user.is_global_admin`)
 * OR the user's Discord ID is in the environment allowlist (`globalAdminDiscordIds`).
 * The env allowlist is kept as an additive OR for backward compatibility.
 */
export const toCurrentUser = (user: User.User): Auth.CurrentUser =>
  new Auth.CurrentUser({
    id: user.id,
    discordId: user.discord_id,
    username: user.username,
    avatar: user.avatar,
    isProfileComplete: user.is_profile_complete,
    name: user.name,
    birthDate: Option.map(user.birth_date, DateTime.formatIsoDateUtc),
    gender: user.gender,
    locale: user.locale,
    isGlobalAdmin: user.is_global_admin || globalAdminDiscordIds.has(user.discord_id),
  });
