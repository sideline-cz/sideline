// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  DiscordNotFoundError,
  DiscordPermanentError,
  DiscordPermissionError,
  DiscordTransientError,
  failAsDiscordError,
  isDiscordNotFoundError,
  isDiscordPermissionError,
  isUnknownMessageError,
  toDiscordError,
} from '~/rest/discordErrors.js';

// ---------------------------------------------------------------------------
// isDiscordPermissionError
// ---------------------------------------------------------------------------

describe('isDiscordPermissionError', () => {
  it('HTTP 403 with code 50013 → true', () => {
    const error = {
      response: { status: 403 },
      data: { code: 50013, message: 'Missing Permissions' },
    };
    expect(isDiscordPermissionError(error)).toBe(true);
  });

  it('HTTP 403 alone (no data.code) → true', () => {
    const error = { response: { status: 403 } };
    expect(isDiscordPermissionError(error)).toBe(true);
  });

  it('code 50013 alone (no response.status) → true', () => {
    const error = { data: { code: 50013 } };
    expect(isDiscordPermissionError(error)).toBe(true);
  });

  it('unrelated code/status → false', () => {
    const error = { response: { status: 404 }, data: { code: 10011 } };
    expect(isDiscordPermissionError(error)).toBe(false);
  });

  it('non-object input → false', () => {
    expect(isDiscordPermissionError(null)).toBe(false);
    expect(isDiscordPermissionError(undefined)).toBe(false);
    expect(isDiscordPermissionError('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDiscordNotFoundError
// ---------------------------------------------------------------------------

describe('isDiscordNotFoundError', () => {
  it('HTTP 404 → true', () => {
    const error = { response: { status: 404 } };
    expect(isDiscordNotFoundError(error)).toBe(true);
  });

  it('code 10011 (Unknown Role) → true', () => {
    const error = { data: { code: 10011 } };
    expect(isDiscordNotFoundError(error)).toBe(true);
  });

  it('code 10013 (Unknown User) → true', () => {
    const error = { data: { code: 10013 } };
    expect(isDiscordNotFoundError(error)).toBe(true);
  });

  it('code 10007 (Unknown Member) with no response.status → true', () => {
    const error = { data: { code: 10007 } };
    expect(isDiscordNotFoundError(error)).toBe(true);
  });

  it('unrelated code/status → false', () => {
    const error = { response: { status: 403 }, data: { code: 50013 } };
    expect(isDiscordNotFoundError(error)).toBe(false);
  });

  it('non-object input → false', () => {
    expect(isDiscordNotFoundError(null)).toBe(false);
    expect(isDiscordNotFoundError(undefined)).toBe(false);
    expect(isDiscordNotFoundError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUnknownMessageError
// ---------------------------------------------------------------------------

describe('isUnknownMessageError', () => {
  it('code 10008 (Unknown Message) → true', () => {
    const error = { data: { code: 10008 } };
    expect(isUnknownMessageError(error)).toBe(true);
  });

  it('HTTP 404 alone (no data.code) → false', () => {
    // Deliberately code-only: a bare 404 says nothing about WHICH resource is
    // missing, and this predicate drives a row replacement in handleReconcile.
    const error = { response: { status: 404 } };
    expect(isUnknownMessageError(error)).toBe(false);
  });

  it('code 10003 (Unknown Channel) with a 404 status → false', () => {
    // The channel, not the message, is what's missing — must not fire, or the
    // reconcile path would recreate a message in a channel that no longer exists.
    const error = { response: { status: 404 }, data: { code: 10003 } };
    expect(isUnknownMessageError(error)).toBe(false);
  });

  it('unrelated code 50013 (Missing Permissions), no 404 status → false', () => {
    const error = { response: { status: 403 }, data: { code: 50013 } };
    expect(isUnknownMessageError(error)).toBe(false);
  });

  it('unrelated code (10011 Unknown Role) with a non-404 status → false', () => {
    // Not this classifier's job to fire on role errors — narrower than isDiscordNotFoundError.
    const error = { response: { status: 400 }, data: { code: 10011 } };
    expect(isUnknownMessageError(error)).toBe(false);
  });

  it('non-object input → false', () => {
    expect(isUnknownMessageError(null)).toBe(false);
    expect(isUnknownMessageError(undefined)).toBe(false);
    expect(isUnknownMessageError('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toDiscordError — classification into semantic tagged errors
// ---------------------------------------------------------------------------

const errorResponse = (code: number, status: number): unknown => ({
  _tag: 'ErrorResponse',
  data: { code, message: `Discord error ${code}` },
  response: { status },
});

describe('toDiscordError', () => {
  it('403 → DiscordPermissionError', () => {
    expect(toDiscordError(errorResponse(0, 403))).toBeInstanceOf(DiscordPermissionError);
  });

  it('code 50013 → DiscordPermissionError', () => {
    expect(toDiscordError(errorResponse(50013, 400))).toBeInstanceOf(DiscordPermissionError);
  });

  it('404 → DiscordNotFoundError', () => {
    expect(toDiscordError(errorResponse(0, 404))).toBeInstanceOf(DiscordNotFoundError);
  });

  it('code 10011 → DiscordNotFoundError', () => {
    expect(toDiscordError(errorResponse(10011, 400))).toBeInstanceOf(DiscordNotFoundError);
  });

  it('other non-429 4xx → DiscordPermanentError', () => {
    expect(toDiscordError(errorResponse(0, 400))).toBeInstanceOf(DiscordPermanentError);
  });

  it('ParseError → DiscordPermanentError', () => {
    expect(toDiscordError({ _tag: 'ParseError' })).toBeInstanceOf(DiscordPermanentError);
  });

  it('non-ErrorResponse transport (HttpClientError) → DiscordTransientError', () => {
    expect(toDiscordError({ _tag: 'HttpClientError' })).toBeInstanceOf(DiscordTransientError);
  });

  it('RatelimitedResponse (429) → DiscordTransientError', () => {
    expect(
      toDiscordError({ _tag: 'RatelimitedResponse', response: { status: 429 } }),
    ).toBeInstanceOf(DiscordTransientError);
  });

  it('unrecognized value → DiscordTransientError (safe, retryable default)', () => {
    expect(toDiscordError(null)).toBeInstanceOf(DiscordTransientError);
    expect(toDiscordError('boom')).toBeInstanceOf(DiscordTransientError);
  });

  it('preserves the original cause', () => {
    const raw = errorResponse(0, 403);
    expect(toDiscordError(raw).cause).toBe(raw);
  });
});

describe('failAsDiscordError', () => {
  it('fails with the mapped tagged error, carrying the original cause', () => {
    const raw = errorResponse(0, 403);
    const error = Effect.runSync(Effect.flip(failAsDiscordError(raw)));
    expect(error).toBeInstanceOf(DiscordPermissionError);
    expect(error.cause).toBe(raw);
  });
});
