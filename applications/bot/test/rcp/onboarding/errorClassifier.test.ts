// TDD mode — these tests will FAIL until Phase 5 implements:
//   applications/bot/src/rcp/onboarding/errorClassifier.ts
// That module does not exist yet. TypeScript "cannot find module" errors are expected.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { classifyOnboardingError } from '~/rcp/onboarding/errorClassifier.js';

// ---------------------------------------------------------------------------
// Fake Discord error shapes (mirroring dfx DiscordREST Generated.d.ts)
// ---------------------------------------------------------------------------

const ROLE_ID = '555555555555555555';
const CHANNEL_ID = '222222222222222222';
const OTHER_ROLE_ID = '999999999999999999';
const OTHER_CHANNEL_ID = '888888888888888888';

const makeTeamCtx = (overrides: Record<string, unknown> = {}) => ({
  rules_channel_id: Option.some(CHANNEL_ID),
  onboarding_rules_role_id: Option.some(ROLE_ID),
  ...overrides,
});

const makeErrorResponse = (code: number, message: string, errors?: unknown) =>
  ({
    _tag: 'ErrorResponse',
    code,
    message,
    errors: errors ?? {},
  }) as any;

const makeRatelimitedResponse = (retry_after = 1.5) =>
  ({
    _tag: 'RatelimitedResponse',
    message: 'You are being rate limited.',
    retry_after,
    global: false,
  }) as any;

const makeHttpClientError = () =>
  ({
    _tag: 'RequestError',
    request: {},
    reason: 'Transport',
    error: new Error('ECONNREFUSED'),
    message: 'ECONNREFUSED',
  }) as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyOnboardingError', () => {
  it('ErrorResponse with code 50035 referencing role snowflake → role_deleted', () => {
    const err = makeErrorResponse(50035, 'Invalid Form Body', {
      prompts: {
        '0': {
          options: {
            '0': {
              role_ids: { '0': { _errors: [`Invalid role: ${ROLE_ID}`] } },
            },
          },
        },
      },
    });
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('role_deleted');
    expect(typeof result.detail).toBe('string');
  });

  it('NEGATIVE: ErrorResponse referencing a DIFFERENT role snowflake → NOT role_deleted (generic)', () => {
    // Classifier must check the team-context snowflake, not just any snowflake in the error body
    const err = makeErrorResponse(50035, 'Invalid Form Body', {
      prompts: {
        '0': {
          options: {
            '0': {
              role_ids: { '0': { _errors: [`Invalid role: ${OTHER_ROLE_ID}`] } },
            },
          },
        },
      },
    });
    const result = classifyOnboardingError(err, makeTeamCtx());
    // Should NOT be role_deleted — the referenced role is not the team's role
    expect(result.code).not.toBe('role_deleted');
    // Falls through to discord_error (or another generic code)
    expect(result.code).toBe('discord_error');
  });

  it('ErrorResponse with code 50035 referencing rules channel snowflake → channel_deleted', () => {
    const err = makeErrorResponse(50035, 'Invalid Form Body', {
      default_channel_ids: {
        '0': { _errors: [`Invalid channel: ${CHANNEL_ID}`] },
      },
    });
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('channel_deleted');
    expect(typeof result.detail).toBe('string');
  });

  it('NEGATIVE: ErrorResponse referencing a DIFFERENT channel snowflake → NOT channel_deleted (generic)', () => {
    // Classifier must match against the team-context channel, not just any channel snowflake
    const err = makeErrorResponse(50035, 'Invalid Form Body', {
      default_channel_ids: {
        '0': { _errors: [`Invalid channel: ${OTHER_CHANNEL_ID}`] },
      },
    });
    const result = classifyOnboardingError(err, makeTeamCtx());
    // Should NOT be channel_deleted — the referenced channel is not the team's channel
    expect(result.code).not.toBe('channel_deleted');
    // Falls through to discord_error (or another generic code)
    expect(result.code).toBe('discord_error');
  });

  it('ErrorResponse with code 50013 (Missing Permissions) → community_not_enabled', () => {
    const err = makeErrorResponse(50013, 'Missing Permissions');
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('community_not_enabled');
    expect(typeof result.detail).toBe('string');
  });

  it('generic ErrorResponse with unknown code → discord_error with raw message in detail', () => {
    const err = makeErrorResponse(99999, 'Some unknown Discord error');
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('discord_error');
    expect(result.detail).toContain('99999');
  });

  it('RatelimitedResponse → rate_limited with retry_after captured', () => {
    const err = makeRatelimitedResponse(2.5);
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('rate_limited');
    // The processor needs retry_after for back-off — it must appear in detail or a dedicated field
    const hasRetryAfter =
      result.retry_after === 2.5 ||
      (typeof result.detail === 'string' && result.detail.includes('2.5'));
    expect(hasRetryAfter).toBe(true);
  });

  it('RatelimitedResponse → retry_after=1.5 round-trips correctly', () => {
    const err = makeRatelimitedResponse(1.5);
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('rate_limited');
    const hasRetryAfter =
      result.retry_after === 1.5 ||
      (typeof result.detail === 'string' && result.detail.includes('1.5'));
    expect(hasRetryAfter).toBe(true);
  });

  it('HttpClientError → network_error', () => {
    const err = makeHttpClientError();
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).toBe('network_error');
  });

  it('NEGATIVE: 50035 error with role snowflake in path string but no UNKNOWN_ROLE code → NOT role_deleted (discord_error)', () => {
    const err = makeErrorResponse(50035, 'Invalid Form Body', {
      prompts: {
        '0': {
          id: {
            _errors: [`Unknown prompt: some-prompt-id referencing path role_ids.${ROLE_ID}`],
          },
        },
      },
    });
    const result = classifyOnboardingError(err, makeTeamCtx());
    expect(result.code).not.toBe('role_deleted');
    expect(result.code).toBe('discord_error');
  });

  it('result is JSON-serializable {code, detail} shape', () => {
    const err = makeErrorResponse(99999, 'Serializable error');
    const result = classifyOnboardingError(err, makeTeamCtx());
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);
    expect(typeof parsed.code).toBe('string');
    expect(typeof parsed.detail).toBe('string');
  });
});
