/** Semantic Discord REST error model. dfx surfaces every REST failure as one of a
 * few transport tags (`ErrorResponse` / `HttpClientError` / `RatelimitedResponse`)
 * whose meaning is buried in an HTTP status / Discord JSON error code. This module
 * classifies those raw shapes and re-fails them as tagged {@link DiscordError}s, so
 * call sites branch with `Effect.catchTag('DiscordPermissionError', …)` instead of
 * re-inlining `err.response.status === 403 || err.data.code === 50013` checks
 * (see AGENTS.md "Classifying a One-Off Discord REST Error"). Low-level shape
 * probing lives in `./recordProbe.js`. */

import { Data, Effect } from 'effect';
import { isRecord, numberProp } from './recordProbe.js';

// ---------------------------------------------------------------------------
// Shape predicates — the raw HTTP-status / Discord-code classification.
// Exported for tests and for the rare caller that needs a boolean rather than a
// tagged failure; prefer the tagged errors + `mapDiscordRestError` for control flow.
// ---------------------------------------------------------------------------

/** Discord's REST error has the HTTP status on `err.response.status` and the
 * Discord JSON error code on `err.data.code`. Only 403 / code 50013 count as
 * "bot lacks permission". */
export const isDiscordPermissionError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const httpStatus = numberProp(error.response, 'status') ?? numberProp(error, 'status');
  if (httpStatus === 403) return true;
  const discordCode = numberProp(error.data, 'code') ?? numberProp(error, 'code');
  return discordCode === 50013;
};

/** 404 (Unknown Member/User/Role) means the role assignment is already gone — treat as
 * success rather than an error. Covers HTTP 404 and Discord JSON error codes
 * Unknown Member (10007), Unknown Role (10011), Unknown User (10013) — the last three
 * can arrive without an HTTP status when surfaced via `err.data.code` alone (e.g. when
 * removing a role from a member who has already left the guild). */
export const isDiscordNotFoundError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const httpStatus = numberProp(error.response, 'status') ?? numberProp(error, 'status');
  if (httpStatus === 404) return true;
  const discordCode = numberProp(error.data, 'code') ?? numberProp(error, 'code');
  return discordCode === 10007 || discordCode === 10011 || discordCode === 10013;
};

/** True for errors that are permanent (retrying will not help):
 * - Any non-429 4xx Discord HTTP error (permission denied, unknown resource, bad request, etc.)
 * - Discord JSON error codes 10xxx (Unknown resource) or 50013 (Missing Permissions)
 * - Any structural error (`_tag: 'ParseError' | 'SchemaError'`)
 *
 * dfx stores the HTTP status at `e.response.status` and the Discord error code at
 * `e.data.code` — NOT at top-level `e.status` / `e.code`. 5xx errors arrive as
 * `_tag: 'HttpClientError'` (dfx `unexpectedStatus`), NOT `ErrorResponse`, and are
 * therefore transient (fall through to `false`).
 *
 * Used both as the `Effect.retry({ while })` / `catchIf` predicate for channel-sync
 * (re-exported from `~/rcp/channel/ProcessorService.js`) and internally by
 * {@link toDiscordError}. */
export const isPermanentError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  if (error._tag === 'ParseError' || error._tag === 'SchemaError') return true;
  if (error._tag !== 'ErrorResponse') return false;
  const status = numberProp(error.response, 'status');
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) return true;
  const code = numberProp(error.data, 'code');
  return code !== undefined && (code === 50013 || (code >= 10000 && code < 11000));
};

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

/** The bot lacks permission for the attempted Discord action (HTTP 403 / code 50013). */
export class DiscordPermissionError extends Data.TaggedError('DiscordPermissionError')<{
  readonly cause: unknown;
}> {}

/** The target resource is already gone (HTTP 404 / codes 10007/10011/10013) — usually
 * safe to treat as an idempotent success. */
export class DiscordNotFoundError extends Data.TaggedError('DiscordNotFoundError')<{
  readonly cause: unknown;
}> {}

/** A permanent REST failure that is neither a permission nor a not-found case
 * (non-429 4xx, structural/parse errors) — retrying will not help. */
export class DiscordPermanentError extends Data.TaggedError('DiscordPermanentError')<{
  readonly cause: unknown;
}> {}

/** A transient REST failure (5xx, rate limit, upstream blip) — retrying may succeed. */
export class DiscordTransientError extends Data.TaggedError('DiscordTransientError')<{
  readonly cause: unknown;
}> {}

export type DiscordError =
  | DiscordPermissionError
  | DiscordNotFoundError
  | DiscordPermanentError
  | DiscordTransientError;

/** Classify any error value into a semantic {@link DiscordError}. Total: an
 * unrecognized shape maps to {@link DiscordTransientError} (the safe, retryable
 * default), mirroring the previous `isPermanentError` fall-through. */
export const toDiscordError = (cause: unknown): DiscordError =>
  isDiscordPermissionError(cause)
    ? new DiscordPermissionError({ cause })
    : isDiscordNotFoundError(cause)
      ? new DiscordNotFoundError({ cause })
      : isPermanentError(cause)
        ? new DiscordPermanentError({ cause })
        : new DiscordTransientError({ cause });

/** The dfx `DiscordREST` transport failure tags. */
export const DISCORD_REST_ERROR_TAGS = [
  'ErrorResponse',
  'HttpClientError',
  'RatelimitedResponse',
] as const;

/** Re-fail a caught dfx REST transport error as a semantic {@link DiscordError}.
 * Use inside `Effect.catchTag(DISCORD_REST_ERROR_TAGS, failAsDiscordError)` so
 * downstream handlers branch on the semantic tag; non-REST errors (RPC, parse …)
 * stay in the channel untouched. */
export const failAsDiscordError = (cause: unknown): Effect.Effect<never, DiscordError> =>
  Effect.fail(toDiscordError(cause));
