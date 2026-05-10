import { Option } from 'effect';

export interface TeamContext {
  readonly rules_channel_id: Option.Option<string>;
  readonly onboarding_rules_role_id: Option.Option<string>;
}

export type OnboardingErrorCode =
  | 'role_deleted'
  | 'channel_deleted'
  | 'community_not_enabled'
  | 'rate_limited'
  | 'discord_error'
  | 'network_error';

export interface ClassifiedError {
  readonly code: OnboardingErrorCode;
  readonly detail: string;
  readonly retry_after?: number;
}

// Discord 50035 error structure (from dfx/DiscordREST generated types):
// {
//   _tag: 'ErrorResponse', code: 50035, message: string,
//   errors: Record<string, { _errors: Array<{ code?: string; message?: string } | string> }>
// }
// We walk the error tree and classify role/channel errors by:
//   (a) an _errors entry with code UNKNOWN_ROLE / UNKNOWN_CHANNEL, or
//   (b) an _errors entry text containing our snowflake AND the node is under a role/channel field key.

const isTagged = <T extends string>(error: unknown, tag: T): error is { _tag: T } =>
  error !== null && typeof error === 'object' && '_tag' in error && error._tag === tag;

const getErrorCode = (entry: unknown): string | undefined => {
  if (entry !== null && typeof entry === 'object' && 'code' in entry) {
    const code = (entry as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const getErrorText = (entry: unknown): string => {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && 'message' in entry) {
    const msg = (entry as { message?: unknown }).message;
    return typeof msg === 'string' ? msg : '';
  }
  return '';
};

const ROLE_FIELD_KEYS = new Set(['role_ids', 'roles']);
const CHANNEL_FIELD_KEYS = new Set(['channel_ids', 'channels', 'default_channel_ids']);
const ROLE_ERROR_CODES = new Set(['UNKNOWN_ROLE', 'INVALID_ROLE']);
const CHANNEL_ERROR_CODES = new Set(['UNKNOWN_CHANNEL', 'INVALID_CHANNEL']);

type MatchKind = 'role' | 'channel' | 'none';

const checkLeaf = (
  errors: ReadonlyArray<unknown>,
  roleId: string | undefined,
  channelId: string | undefined,
  inRoleField: boolean,
  inChannelField: boolean,
): MatchKind => {
  for (const entry of errors) {
    const code = getErrorCode(entry);
    const text = getErrorText(entry);
    if (code !== undefined) {
      if (roleId !== undefined && ROLE_ERROR_CODES.has(code)) return 'role';
      if (channelId !== undefined && CHANNEL_ERROR_CODES.has(code)) return 'channel';
    }
    if (inRoleField && roleId !== undefined && text.includes(roleId)) return 'role';
    if (inChannelField && channelId !== undefined && text.includes(channelId)) return 'channel';
  }
  return 'none';
};

const walkErrors = (
  node: unknown,
  roleId: string | undefined,
  channelId: string | undefined,
  inRoleField: boolean,
  inChannelField: boolean,
): MatchKind => {
  if (node === null || typeof node !== 'object') return 'none';
  const obj: Record<string, unknown> = node as Record<string, unknown>;

  if ('_errors' in obj && Array.isArray(obj._errors)) {
    return checkLeaf(obj._errors, roleId, channelId, inRoleField, inChannelField);
  }

  for (const key of Object.keys(obj)) {
    const nowInRole = inRoleField || ROLE_FIELD_KEYS.has(key);
    const nowInChannel = inChannelField || CHANNEL_FIELD_KEYS.has(key);
    const result = walkErrors(obj[key], roleId, channelId, nowInRole, nowInChannel);
    if (result !== 'none') return result;
  }
  return 'none';
};

export const classifyOnboardingError = (error: unknown, team: TeamContext): ClassifiedError => {
  if (isTagged(error, 'RatelimitedResponse')) {
    const r = error as { message?: string; retry_after?: number };
    const retry_after = typeof r.retry_after === 'number' ? r.retry_after : undefined;
    return {
      code: 'rate_limited',
      detail: `Rate limited. retry_after=${retry_after ?? 'unknown'}`,
      ...(retry_after !== undefined ? { retry_after } : {}),
    };
  }

  if (isTagged(error, 'RequestError')) {
    const message = getErrorText(error);
    return {
      code: 'network_error',
      detail: message !== '' ? message : 'Network error',
    };
  }

  if (isTagged(error, 'ErrorResponse')) {
    const e = error as { code?: number; message?: string; errors?: unknown };
    const code = e.code ?? 0;
    const message = e.message ?? '';

    if (code === 50013 || message.toLowerCase().includes('community')) {
      return {
        code: 'community_not_enabled',
        detail: `Discord error ${code}: ${message}`,
      };
    }

    if (code === 50035) {
      const roleId = Option.getOrUndefined(team.onboarding_rules_role_id);
      const channelId = Option.getOrUndefined(team.rules_channel_id);

      const match = walkErrors(e.errors, roleId, channelId, false, false);
      if (match === 'role') {
        return {
          code: 'role_deleted',
          detail: `Discord error 50035: references role ${roleId}`,
        };
      }
      if (match === 'channel') {
        return {
          code: 'channel_deleted',
          detail: `Discord error 50035: references channel ${channelId}`,
        };
      }
    }

    return {
      code: 'discord_error',
      detail: `Discord error ${code}: ${message}`,
    };
  }

  const fallbackMsg = getErrorText(error);
  return {
    code: 'discord_error',
    detail: fallbackMsg !== '' ? fallbackMsg : String(error),
  };
};
