import type { RoleApi } from '@sideline/domain';

export interface ClassifiedRoleSyncError {
  readonly code: RoleApi.DiscordSyncErrorCode;
  readonly detail: string;
  readonly retry_after?: number;
  /**
   * Mirrors `applications/bot/src/rcp/inviteGenerator/errorClassifier.ts` (CC-0): `false` means
   * the failure must never be recorded as a user-visible sync failure — a 429 or a 5xx is
   * Discord's own outage/rate limit, not something a captain or player can act on, and the
   * level-based diff (`CC-10`) re-derives the missing role change on the next reconcile pass
   * regardless. `Role/MarkEventFailed` only carries `error_code: Some(...)` (which
   * `team_members.last_role_sync_*` is written from) when this is `true`; `role_sync_events`
   * itself is always marked processed either way, since that queue is not the retry mechanism.
   */
  readonly terminal: boolean;
}

// Four buckets (CC-8 / PR-7), not the nine-code union PR-3's classifier writes. A code added to
// `RoleApi.DiscordSyncErrorCode` without an entry here is a compile error.
export const TERMINAL_ROLE_SYNC_ERROR_CODES: Record<RoleApi.DiscordSyncErrorCode, boolean> = {
  retryable: false,
  captain_action: true,
  user_action: true,
  unknown: true,
};

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

const recordProp = (
  entry: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = entry[key];
  return isRecord(value) ? value : undefined;
};

// Same shape as `inviteGenerator/errorClassifier.ts`'s equivalent — see that file's top-of-file
// comment for the full justification (no `RequestError` tag in this effect version; every
// HTTP-layer failure surfaces as `HttpClientError` with the real kind on `reason._tag`).
const isServerHttpStatus = (status: number): boolean => status >= 500 && status < 600;

const classifyHttpClientError = (error: Record<string, unknown>): ClassifiedRoleSyncError => {
  const reason = recordProp(error, 'reason');
  const reasonTag = reason !== undefined ? stringProp(reason, '_tag') : undefined;

  if (reasonTag === 'TransportError') {
    const description = reason !== undefined ? stringProp(reason, 'description') : undefined;
    return {
      code: 'retryable',
      detail:
        description !== undefined && description !== '' ? description : 'Network transport error',
      terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.retryable,
    };
  }

  if (reasonTag === 'StatusCodeError') {
    const response = recordProp(error, 'response');
    const status = response !== undefined ? numberProp(response, 'status') : undefined;

    if (status !== undefined && isServerHttpStatus(status)) {
      return {
        code: 'retryable',
        detail: `HTTP ${status}: Discord server error`,
        terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.retryable,
      };
    }

    if (status === 429) {
      const headers = response !== undefined ? recordProp(response, 'headers') : undefined;
      const retryAfterHeader =
        headers !== undefined ? stringProp(headers, 'retry-after') : undefined;
      const retry_after = retryAfterHeader !== undefined ? Number(retryAfterHeader) : undefined;
      return {
        code: 'retryable',
        detail: 'HTTP 429 (arrived as HttpClientError, not RatelimitedResponse)',
        ...(retry_after !== undefined && !Number.isNaN(retry_after) ? { retry_after } : {}),
        terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.retryable,
      };
    }

    return {
      code: 'unknown',
      detail:
        status !== undefined
          ? `HTTP ${status}: Discord client error`
          : 'HttpClientError (StatusCodeError, no status)',
      terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.unknown,
    };
  }

  return {
    code: 'unknown',
    detail: reasonTag !== undefined ? `HttpClientError (${reasonTag})` : 'HttpClientError',
    terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.unknown,
  };
};

/**
 * Classifies a role-sync failure (from `addGuildMemberRole` / `deleteGuildMemberRole`, or the
 * rest of `handleAssigned.ts` / `handleUnassigned.ts` / `handleCreated.ts` / `handleDeleted.ts`)
 * into the four-bucket `RoleApi.DiscordSyncErrorCode` PR-7 already shipped (CC-8).
 *
 * - 50013 (Missing Permissions) is `captain_action` — Discord returns the exact same code for
 *   "bot lacks Manage Roles" and "the target role sits above the bot's own role in the
 *   hierarchy" (designer open question 4: they are indistinguishable, so they share one bucket
 *   and the copy names both remedies).
 * - 10007 (Unknown Member) is `user_action` — the member left the guild before the sync ran.
 * - Everything else Discord-side (including other `ErrorResponse` codes) falls back to
 *   `unknown`, terminal — never silently retried forever on an error we can't name.
 */
export const classifyRoleSyncError = (error: unknown): ClassifiedRoleSyncError => {
  if (isTagged(error, 'RatelimitedResponse')) {
    const retry_after = numberProp(error, 'retry_after');
    return {
      code: 'retryable',
      detail: `Rate limited. retry_after=${retry_after ?? 'unknown'}`,
      ...(retry_after !== undefined ? { retry_after } : {}),
      terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.retryable,
    };
  }

  if (isTagged(error, 'HttpClientError')) {
    return classifyHttpClientError(error);
  }

  if (isTagged(error, 'ErrorResponse')) {
    const code = numberProp(error, 'code') ?? 0;
    const message = stringProp(error, 'message') ?? '';

    // 50013 = Missing Permissions: bot can't manage roles, OR the target role sits above the
    // bot's own top role. Discord does not distinguish the two (designer open question 4).
    if (code === 50013) {
      return {
        code: 'captain_action',
        detail: `Discord error ${code}: ${message}`,
        terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.captain_action,
      };
    }

    // 10007 = Unknown Member: the member left the guild before this event was processed.
    if (code === 10007) {
      return {
        code: 'user_action',
        detail: `Discord error ${code}: ${message}`,
        terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.user_action,
      };
    }

    return {
      code: 'unknown',
      detail: `Discord error ${code}: ${message}`,
      terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.unknown,
    };
  }

  const fallbackMsg = isRecord(error) ? (stringProp(error, 'message') ?? '') : '';
  return {
    code: 'unknown',
    detail: fallbackMsg !== '' ? fallbackMsg : String(error),
    terminal: TERMINAL_ROLE_SYNC_ERROR_CODES.unknown,
  };
};
