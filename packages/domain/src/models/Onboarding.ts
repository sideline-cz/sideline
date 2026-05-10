import { Schema } from 'effect';

export const OnboardingLocale = Schema.Literals(['en', 'cs']);
export type OnboardingLocale = typeof OnboardingLocale.Type;

export const OnboardingSyncStatus = Schema.Literals(['pending', 'syncing', 'done', 'failed']);
export type OnboardingSyncStatus = typeof OnboardingSyncStatus.Type;

export const OnboardingSyncErrorCode = Schema.Literals([
  'community_not_enabled',
  'role_deleted',
  'channel_deleted',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
]);
export type OnboardingSyncErrorCode = typeof OnboardingSyncErrorCode.Type;
