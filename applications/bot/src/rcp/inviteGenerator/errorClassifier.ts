import type { Onboarding } from '@sideline/domain';

export interface ClassifiedError {
  readonly code: Onboarding.InviteGeneratorErrorCode;
  readonly detail: string;
  readonly retry_after?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const isTagged = <T extends string>(
  error: unknown,
  tag: T,
): error is Record<string, unknown> & { _tag: T } =>
  isRecord(error) && '_tag' in error && error._tag === tag;

const stringProp = (entry: Record<string, unknown>, key: string): string | undefined => {
  const value = entry[key];
  return typeof value === 'string' ? value : undefined;
};

const numberProp = (entry: Record<string, unknown>, key: string): number | undefined => {
  const value = entry[key];
  return typeof value === 'number' ? value : undefined;
};

export const classifyInviteGeneratorError = (error: unknown): ClassifiedError => {
  if (isTagged(error, 'RatelimitedResponse')) {
    const retry_after = numberProp(error, 'retry_after');
    return {
      code: 'rate_limited',
      detail: `Rate limited. retry_after=${retry_after ?? 'unknown'}`,
      ...(retry_after !== undefined ? { retry_after } : {}),
    };
  }

  if (isTagged(error, 'RequestError')) {
    const message = stringProp(error, 'message') ?? '';
    return {
      code: 'network_error',
      detail: message !== '' ? message : 'Network error',
    };
  }

  if (isTagged(error, 'ErrorResponse')) {
    const code = numberProp(error, 'code') ?? 0;
    const message = stringProp(error, 'message') ?? '';

    // 10003 = Unknown Channel: the welcome channel was deleted on Discord's side.
    if (code === 10003) {
      return {
        code: 'welcome_channel_deleted',
        detail: `Discord error ${code}: ${message}`,
      };
    }

    // 50013 = Missing Permissions: bot can't manage channels on the welcome channel.
    if (code === 50013) {
      return {
        code: 'bot_missing_perms',
        detail: `Discord error ${code}: ${message}`,
      };
    }

    if (message.toLowerCase().includes('community')) {
      return {
        code: 'community_not_enabled',
        detail: `Discord error ${code}: ${message}`,
      };
    }

    return {
      code: 'discord_error',
      detail: `Discord error ${code}: ${message}`,
    };
  }

  const fallbackMsg = isRecord(error) ? (stringProp(error, 'message') ?? '') : '';
  return {
    code: 'unknown',
    detail: fallbackMsg !== '' ? fallbackMsg : String(error),
  };
};
