// PR-9 (Discord onboarding fix), 9b — `classifyRoleSyncError` mirrors
// `applications/bot/src/rcp/inviteGenerator/errorClassifier.ts`, including its `terminal` flag
// (CC-0): a 429 or a 5xx must never be recorded as a user-visible role-sync failure. Maps onto
// the four-bucket `RoleApi.DiscordSyncErrorCode` PR-7 already shipped (CC-8) — `retryable`,
// `captain_action` (50013 — missing permission AND role hierarchy, indistinguishable on the
// wire), `user_action` (10007 — member left), `unknown` (fallback).

import type { RoleApi } from '@sideline/domain';
import { describe, expect, it } from 'vitest';
import {
  classifyRoleSyncError,
  TERMINAL_ROLE_SYNC_ERROR_CODES,
} from '~/rcp/role/errorClassifier.js';

const ALL_CODES: ReadonlyArray<RoleApi.DiscordSyncErrorCode> = [
  'retryable',
  'captain_action',
  'user_action',
  'unknown',
];

describe('classifyRoleSyncError', () => {
  // Blocker 3's TOCTOU re-check (`handleAssigned.ts`) fails with this tag when a role's live
  // permissions are dangerous or unverifiable — whole-series review, "also fix" item: this
  // failure used to be swallowed (resolved, not rejected), so `Role/MarkEventProcessed` recorded
  // a refused assignment as `'ok'`. It must classify the same way 50013 does.
  it('classifies an UnsafeRoleAssignmentError as captain_action', () => {
    const result = classifyRoleSyncError({
      _tag: 'UnsafeRoleAssignmentError',
      discordRoleId: '555555555555555555',
      guildId: '111111111111111111',
      discordUserId: '444444444444444444',
    });
    expect(result.code).toBe('captain_action');
    expect(result.terminal).toBe(true);
  });

  it('classifies a 50013 ErrorResponse as captain_action (missing permission or role hierarchy)', () => {
    const result = classifyRoleSyncError({
      _tag: 'ErrorResponse',
      code: 50013,
      message: 'Missing Permissions',
    });
    expect(result.code).toBe('captain_action');
    expect(result.terminal).toBe(true);
  });

  it('classifies a 10007 ErrorResponse (Unknown Member) as user_action', () => {
    const result = classifyRoleSyncError({
      _tag: 'ErrorResponse',
      code: 10007,
      message: 'Unknown Member',
    });
    expect(result.code).toBe('user_action');
    expect(result.terminal).toBe(true);
  });

  it('classifies a RatelimitedResponse as retryable and terminal: false', () => {
    const result = classifyRoleSyncError({
      _tag: 'RatelimitedResponse',
      message: 'You are being rate limited.',
      retry_after: 1.5,
      global: false,
    });
    expect(result.code).toBe('retryable');
    expect(result.terminal).toBe(false);
    expect(result.retry_after).toBe(1.5);
  });

  it('classifies an HttpClientError/StatusCodeError 429 as retryable and terminal: false', () => {
    const result = classifyRoleSyncError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 429, headers: { 'retry-after': '2' } },
    });
    expect(result.code).toBe('retryable');
    expect(result.terminal).toBe(false);
    expect(result.retry_after).toBe(2);
  });

  it('classifies an HttpClientError/StatusCodeError 5xx as retryable and terminal: false (Discord outage)', () => {
    const result = classifyRoleSyncError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 503 },
    });
    expect(result.code).toBe('retryable');
    expect(result.terminal).toBe(false);
  });

  it('classifies an HttpClientError wrapping a TransportError (network) as retryable, terminal: false', () => {
    const result = classifyRoleSyncError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError', description: 'ECONNREFUSED' },
    });
    expect(result.code).toBe('retryable');
    expect(result.terminal).toBe(false);
  });

  it('classifies an unmapped Discord ErrorResponse code as unknown, terminal: true', () => {
    const result = classifyRoleSyncError({
      _tag: 'ErrorResponse',
      code: 40001,
      message: 'Some other client-facing error',
    });
    expect(result.code).toBe('unknown');
    expect(result.terminal).toBe(true);
  });

  it('classifies a bare HttpClientError with no recognizable reason as unknown, terminal: true', () => {
    const result = classifyRoleSyncError({ _tag: 'HttpClientError' });
    expect(result.code).toBe('unknown');
    expect(result.terminal).toBe(true);
  });

  it('classifies a non-HTTP-status HttpClientError/StatusCodeError as unknown, terminal: true', () => {
    const result = classifyRoleSyncError({
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 403 },
    });
    expect(result.code).toBe('unknown');
    expect(result.terminal).toBe(true);
  });

  it('classifies a totally unrecognized error shape as unknown, terminal: true', () => {
    const result = classifyRoleSyncError(new Error('boom'));
    expect(result.code).toBe('unknown');
    expect(result.terminal).toBe(true);
  });

  it('TERMINAL_ROLE_SYNC_ERROR_CODES has an entry for every DiscordSyncErrorCode literal', () => {
    for (const code of ALL_CODES) {
      expect(typeof TERMINAL_ROLE_SYNC_ERROR_CODES[code]).toBe('boolean');
    }
    expect(TERMINAL_ROLE_SYNC_ERROR_CODES.retryable).toBe(false);
    expect(TERMINAL_ROLE_SYNC_ERROR_CODES.captain_action).toBe(true);
    expect(TERMINAL_ROLE_SYNC_ERROR_CODES.user_action).toBe(true);
    expect(TERMINAL_ROLE_SYNC_ERROR_CODES.unknown).toBe(true);
  });
});
