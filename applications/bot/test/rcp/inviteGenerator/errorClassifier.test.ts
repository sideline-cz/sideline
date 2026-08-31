// PR-3 (Discord onboarding fix), CC-0 / blocker 2 — `classifyInviteGeneratorError` now returns
// `terminal: boolean` alongside `code`/`detail`/`retry_after`. Transient codes (`rate_limited`,
// `network_error`, and `discord_error` when Discord's own status is 5xx) must never be terminal —
// `ProcessorService` relies on this to decide whether to call `Invite/MarkAcceptanceFailed` at all.
//
// Real shapes (verified against the installed `effect`/`dfx` packages — see
// `errorClassifier.ts`'s top-of-file comment): `createChannelInvite`'s error channel is
// `HttpClientError.HttpClientError | DiscordRestError<'RatelimitedResponse', ...> |
// DiscordRestError<'ErrorResponse', ...>`. There is no `RequestError` tag in this effect version —
// every HTTP-layer failure (transport failure, or dfx's `unexpectedStatus` fallback for a status
// that isn't a declared success/429/4xx code) surfaces as a single `_tag: 'HttpClientError'` whose
// specific kind lives on the nested `reason._tag`, and whose real HTTP status (when there is one)
// lives on `.response.status` (the real class's `.response` getter forwards to `.reason.response`;
// fakes below put `response` at the top level to mirror that, matching the existing convention in
// `test/rcp/channel/ProcessorService.test.ts`).

import type { Onboarding } from '@sideline/domain';
import { describe, expect, it } from 'vitest';
import {
  classifyInviteGeneratorError,
  TERMINAL_ERROR_CODES,
} from '~/rcp/inviteGenerator/errorClassifier.js';

// Every stored `InviteGeneratorErrorCode` literal. Kept as an explicit array (rather than reading
// `Onboarding.InviteGeneratorErrorCode.literals`) so this test's expectations are independent of
// how the domain schema happens to expose its literal set.
const ALL_CODES: ReadonlyArray<Onboarding.InviteGeneratorErrorCode> = [
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
];

describe('classifyInviteGeneratorError — terminal vs transient (blocker 2)', () => {
  it('does NOT terminally classify a RatelimitedResponse', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'RatelimitedResponse',
      message: 'You are being rate limited.',
      retry_after: 2.5,
      global: false,
    });
    expect(result.code).toBe('rate_limited');
    expect(result.terminal).toBe(false);
    expect(result.retry_after).toBe(2.5);
  });

  // Regression: `RequestError` is a dead tag in this effect version (there is no such `_tag` —
  // see `HttpClientError.d.ts`). A genuine network failure actually arrives as
  // `{ _tag: 'HttpClientError', reason: { _tag: 'TransportError', ... } }`. Before this fix, this
  // shape fell through every branch to `unknown`, which is terminal — exactly the blip that
  // permanently kills the invite that blocker 2 exists to prevent.
  it('does NOT terminally classify an HttpClientError wrapping a TransportError (network)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError', description: 'ECONNREFUSED' },
    });
    expect(result.code).toBe('network_error');
    expect(result.terminal).toBe(false);
  });

  // A bare/unrecognized `HttpClientError` (no discoverable `reason` kind) — we have no evidence
  // it's a transport failure, so it defaults terminal rather than silently retrying forever.
  it('DOES terminally classify a bare HttpClientError with no recognizable reason', () => {
    const result = classifyInviteGeneratorError({ _tag: 'HttpClientError' });
    expect(result.terminal).toBe(true);
  });

  // `EncodeError` / `InvalidUrlError` / `DecodeError` / `EmptyBodyError` are our own request or
  // response handling bugs, not a Discord or network blip — terminal.
  it('DOES terminally classify an HttpClientError wrapping an EncodeError (our own bug)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'HttpClientError',
      reason: { _tag: 'EncodeError', description: 'failed to encode request body' },
    });
    expect(result.terminal).toBe(true);
  });

  it('does NOT terminally classify an HttpClientError/StatusCodeError with a 503 (Discord outage)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 503 },
    });
    expect(result.code).toBe('discord_error');
    expect(result.terminal).toBe(false);
  });

  it('DOES terminally classify an HttpClientError/StatusCodeError with a 403 (client mistake)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 403 },
    });
    expect(result.code).toBe('discord_error');
    expect(result.terminal).toBe(true);
  });

  // Defensive only: dfx already routes a real 429 to `RatelimitedResponse` before it reaches
  // `HttpClientError`/`StatusCodeError`, so this should not be reachable for `createChannelInvite`
  // in practice — but the classifier must not treat it as a client mistake if it ever is.
  it('does NOT terminally classify an HttpClientError/StatusCodeError with a 429, and picks up retry-after', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 429, headers: { 'retry-after': '3' } },
    });
    expect(result.code).toBe('rate_limited');
    expect(result.terminal).toBe(false);
    expect(result.retry_after).toBe(3);
  });

  // Fix #2's regression: `ErrorResponse.code` is Discord's *internal* error code, not an HTTP
  // status — a code that happens to fall in 500-599 is not evidence of a server outage and must
  // not be treated as transient.
  it('DOES terminally classify an ErrorResponse whose Discord code happens to be in the 5xx range', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'ErrorResponse',
      code: 500,
      message: 'Some Discord-internal code that happens to look like a status',
    });
    expect(result.code).toBe('discord_error');
    expect(result.terminal).toBe(true);
  });

  it('DOES terminally classify a non-5xx discord_error (client mistake)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'ErrorResponse',
      code: 40001,
      message: 'Some client-facing error',
    });
    expect(result.code).toBe('discord_error');
    expect(result.terminal).toBe(true);
  });

  it('DOES terminally classify a 50013 ErrorResponse (bot_missing_perms)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'ErrorResponse',
      code: 50013,
      message: 'Missing Permissions',
    });
    expect(result.code).toBe('bot_missing_perms');
    expect(result.terminal).toBe(true);
  });

  it('DOES terminally classify a 10003 ErrorResponse (welcome_channel_deleted)', () => {
    const result = classifyInviteGeneratorError({
      _tag: 'ErrorResponse',
      code: 10003,
      message: 'Unknown Channel',
    });
    expect(result.code).toBe('welcome_channel_deleted');
    expect(result.terminal).toBe(true);
  });

  it('DOES terminally classify an unrecognized error shape (unknown)', () => {
    const result = classifyInviteGeneratorError(new Error('something unexpected'));
    expect(result.code).toBe('unknown');
    expect(result.terminal).toBe(true);
  });

  // Blocker 2's completeness gate: every code in the stored union must have an explicit
  // terminal/transient entry. Because `TERMINAL_ERROR_CODES` is typed `Record<InviteGeneratorErrorCode,
  // boolean>`, a new literal added to the domain schema without an entry here is already a
  // compile error — this test additionally pins the current values so a silent value-level
  // regression (e.g. someone widening the type to `Partial<...>` to dodge the compile error)
  // still fails at runtime.
  it.each(ALL_CODES)('has an explicit boolean terminal classification for %s', (code) => {
    expect(typeof TERMINAL_ERROR_CODES[code]).toBe('boolean');
  });

  it('rate_limited and network_error are transient; everything else defaults terminal', () => {
    expect(TERMINAL_ERROR_CODES.rate_limited).toBe(false);
    expect(TERMINAL_ERROR_CODES.network_error).toBe(false);
    expect(TERMINAL_ERROR_CODES.welcome_channel_missing).toBe(true);
    expect(TERMINAL_ERROR_CODES.welcome_channel_deleted).toBe(true);
    expect(TERMINAL_ERROR_CODES.bot_missing_perms).toBe(true);
    expect(TERMINAL_ERROR_CODES.community_not_enabled).toBe(true);
    expect(TERMINAL_ERROR_CODES.discord_error).toBe(true);
    expect(TERMINAL_ERROR_CODES.unknown).toBe(true);
    expect(TERMINAL_ERROR_CODES.bot_not_in_guild).toBe(true);
    expect(TERMINAL_ERROR_CODES.expired).toBe(true);
  });
});
