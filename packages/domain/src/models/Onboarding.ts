import { Schema } from 'effect';

export const OnboardingLocale = Schema.Literals(['en', 'cs']);
export type OnboardingLocale = typeof OnboardingLocale.Type;

export const OnboardingSyncStatus = Schema.Literals(['pending', 'syncing', 'done', 'failed']);
export type OnboardingSyncStatus = typeof OnboardingSyncStatus.Type;

export const OnboardingSyncErrorCode = Schema.Literals([
  'community_not_enabled',
  'requirements_not_met',
  'default_channel_private',
  'too_many_prompts',
  'role_deleted',
  'channel_deleted',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
]);
export type OnboardingSyncErrorCode = typeof OnboardingSyncErrorCode.Type;

// PR-2 wire expand (CC-3): this is the STORED enum — read via `InviteAcceptance.InviteAcceptance`
// (a `SELECT *` decode) and `Invite/MarkAcceptanceFailed` (bot -> server), both of which the
// server and the bot decode. `'bot_not_in_guild'` (added in PR-3) and `'expired'` (written by
// PR-3's pre-deploy sweep + cron) must be here even though NOTHING emits them yet this release,
// and even though `'expired'` never reaches a browser — `JoinStatus.state` carries it instead
// (see `Invite.JoinStatusErrorCode` for the separate, narrower client-facing union, and
// `applications/server/src/utils/inviteErrorWireProjection.ts` for the projection between them).
export const InviteGeneratorErrorCode = Schema.Literals([
  'welcome_channel_missing',
  'welcome_channel_deleted',
  'bot_missing_perms',
  'community_not_enabled',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
  'bot_not_in_guild',
  'expired',
]);
export type InviteGeneratorErrorCode = typeof InviteGeneratorErrorCode.Type;
