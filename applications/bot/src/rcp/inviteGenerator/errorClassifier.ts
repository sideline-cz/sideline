import type { Onboarding } from '@sideline/domain';

export interface ClassifiedError {
  readonly code: Onboarding.InviteGeneratorErrorCode;
  readonly detail: string;
  readonly retry_after?: number;
  /**
   * CC-0 / blocker 2: `false` means the row must NOT be marked failed — it stays open (no
   * `discord_code`, no `discord_code_error_code`) so the next `fastPollLoop` tick retries it.
   * `true` means a human must act (or the CC-4 sweep must close it); `Invite/MarkAcceptanceFailed`
   * is the only caller allowed to write a terminal code.
   */
  readonly terminal: boolean;
}

// Canonical terminal/transient classification for every stored `InviteGeneratorErrorCode`
// literal. A `Record` over the full union means a new literal added to the domain model without
// an entry here is a compile error — see `errorClassifier.test.ts` test 21, which additionally
// pins this at the value level so an incomplete `Record` literal can't slip through a widened
// index signature. Exported so that test can assert completeness directly, without needing to
// construct an error shape for the three codes this classifier never itself produces
// (`welcome_channel_missing` / `bot_not_in_guild` are written by `ProcessorService`'s
// short-circuits; `expired` is written only by the sweep).
//
// `discord_error`'s table entry is the terminal (4xx) default; the one exception — a real HTTP
// 5xx status arriving via `HttpClientError`/`StatusCodeError`, Discord's own outage rather than a
// client mistake — is computed per-call below and overrides this default to `false`.
export const TERMINAL_ERROR_CODES: Record<Onboarding.InviteGeneratorErrorCode, boolean> = {
  welcome_channel_missing: true,
  welcome_channel_deleted: true,
  bot_missing_perms: true,
  community_not_enabled: true,
  rate_limited: false,
  discord_error: true,
  network_error: false,
  unknown: true,
  bot_not_in_guild: true,
  expired: true,
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

// A real HTTP status (from `HttpClientError`/`StatusCodeError`) of 5xx is Discord's own outage,
// not a client mistake — the caller should retry, not fail the row. NOT the same check as
// `ErrorResponse.code`, which is Discord's internal error code, not an HTTP status.
const isServerHttpStatus = (status: number): boolean => status >= 500 && status < 600;

// `createChannelInvite`'s error channel (dfx 1.0.11, `dist/DiscordREST/Generated.d.ts`) is
// exactly `HttpClientError.HttpClientError | DiscordRestError<'RatelimitedResponse', ...> |
// DiscordRestError<'ErrorResponse', ...>`. There is no `RequestError` tag in this effect version
// (`effect/dist/unstable/http/HttpClientError.d.ts` declares `HttpClientError`, `TransportError`,
// `EncodeError`, `InvalidUrlError`, `StatusCodeError`, `DecodeError`, `EmptyBodyError`) — every
// HTTP-layer failure, including a genuine network failure, surfaces as a single top-level
// `_tag: 'HttpClientError'` whose specific kind lives on the nested `reason._tag`:
//
//   - `TransportError` — a genuine connection/network failure (DNS, refused, timeout, ...). No
//     response was ever received. Transient.
//   - `StatusCodeError` — dfx's fallback (`unexpectedStatus` in `DiscordREST/Generated.js`) for
//     any status that isn't a declared success code or 429/4xx (i.e. 5xx here, in practice) —
//     classify on the real HTTP status carried on `.response.status` (the real class's
//     `.response` getter forwards to `.reason.response`): 5xx → transient (Discord's own outage),
//     429 → transient (defensive only — dfx already routes a real 429 to `RatelimitedResponse`
//     before it would ever reach here), anything else → terminal `discord_error`.
//   - `EncodeError` / `InvalidUrlError` / `DecodeError` / `EmptyBodyError` — our own request or
//     response handling bug, not a Discord or network blip. Terminal.
//   - a missing/unrecognized `reason` (a bare `HttpClientError`) — we have no evidence it wraps a
//     transport failure, so it defaults terminal rather than silently retrying forever.
const classifyHttpClientError = (error: Record<string, unknown>): ClassifiedError => {
  const reason = recordProp(error, 'reason');
  const reasonTag = reason !== undefined ? stringProp(reason, '_tag') : undefined;

  if (reasonTag === 'TransportError') {
    const description = reason !== undefined ? stringProp(reason, 'description') : undefined;
    return {
      code: 'network_error',
      detail:
        description !== undefined && description !== '' ? description : 'Network transport error',
      terminal: TERMINAL_ERROR_CODES.network_error,
    };
  }

  if (reasonTag === 'StatusCodeError') {
    const response = recordProp(error, 'response');
    const status = response !== undefined ? numberProp(response, 'status') : undefined;

    if (status !== undefined && isServerHttpStatus(status)) {
      return {
        code: 'discord_error',
        detail: `HTTP ${status}: Discord server error`,
        // Overrides the table default: a 5xx is Discord's own outage, not a client mistake.
        terminal: false,
      };
    }

    if (status === 429) {
      const headers = response !== undefined ? recordProp(response, 'headers') : undefined;
      const retryAfterHeader =
        headers !== undefined ? stringProp(headers, 'retry-after') : undefined;
      const retry_after = retryAfterHeader !== undefined ? Number(retryAfterHeader) : undefined;
      return {
        code: 'rate_limited',
        detail: 'HTTP 429 (arrived as HttpClientError, not RatelimitedResponse)',
        ...(retry_after !== undefined && !Number.isNaN(retry_after) ? { retry_after } : {}),
        terminal: TERMINAL_ERROR_CODES.rate_limited,
      };
    }

    return {
      code: 'discord_error',
      detail:
        status !== undefined
          ? `HTTP ${status}: Discord client error`
          : 'HttpClientError (StatusCodeError, no status)',
      terminal: TERMINAL_ERROR_CODES.discord_error,
    };
  }

  return {
    code: 'unknown',
    detail: reasonTag !== undefined ? `HttpClientError (${reasonTag})` : 'HttpClientError',
    terminal: TERMINAL_ERROR_CODES.unknown,
  };
};

export const classifyInviteGeneratorError = (error: unknown): ClassifiedError => {
  if (isTagged(error, 'RatelimitedResponse')) {
    const retry_after = numberProp(error, 'retry_after');
    return {
      code: 'rate_limited',
      detail: `Rate limited. retry_after=${retry_after ?? 'unknown'}`,
      ...(retry_after !== undefined ? { retry_after } : {}),
      terminal: TERMINAL_ERROR_CODES.rate_limited,
    };
  }

  if (isTagged(error, 'HttpClientError')) {
    return classifyHttpClientError(error);
  }

  if (isTagged(error, 'ErrorResponse')) {
    const code = numberProp(error, 'code') ?? 0;
    const message = stringProp(error, 'message') ?? '';

    // 10003 = Unknown Channel: the welcome channel was deleted on Discord's side.
    if (code === 10003) {
      return {
        code: 'welcome_channel_deleted',
        detail: `Discord error ${code}: ${message}`,
        terminal: TERMINAL_ERROR_CODES.welcome_channel_deleted,
      };
    }

    // 50013 = Missing Permissions: bot can't manage channels on the welcome channel.
    if (code === 50013) {
      return {
        code: 'bot_missing_perms',
        detail: `Discord error ${code}: ${message}`,
        terminal: TERMINAL_ERROR_CODES.bot_missing_perms,
      };
    }

    if (message.toLowerCase().includes('community')) {
      return {
        code: 'community_not_enabled',
        detail: `Discord error ${code}: ${message}`,
        terminal: TERMINAL_ERROR_CODES.community_not_enabled,
      };
    }

    // `code` here is Discord's *internal* JSON error code (e.g. 40001), not an HTTP status — it
    // is never evidence of a 5xx server outage, even if its numeric value happens to fall in the
    // 500-599 range. A real HTTP 5xx is classified above, via `HttpClientError`/`StatusCodeError`.
    return {
      code: 'discord_error',
      detail: `Discord error ${code}: ${message}`,
      terminal: TERMINAL_ERROR_CODES.discord_error,
    };
  }

  const fallbackMsg = isRecord(error) ? (stringProp(error, 'message') ?? '') : '';
  return {
    code: 'unknown',
    detail: fallbackMsg !== '' ? fallbackMsg : String(error),
    terminal: TERMINAL_ERROR_CODES.unknown,
  };
};
