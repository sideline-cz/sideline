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

export const InviteGeneratorErrorCode = Schema.Literals([
  'welcome_channel_missing',
  'welcome_channel_deleted',
  'bot_missing_perms',
  'community_not_enabled',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
]);
export type InviteGeneratorErrorCode = typeof InviteGeneratorErrorCode.Type;
