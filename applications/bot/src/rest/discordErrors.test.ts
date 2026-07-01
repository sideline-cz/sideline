// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { describe, expect, it } from 'vitest';
import { isDiscordNotFoundError, isDiscordPermissionError } from '~/rest/discordErrors.js';

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
