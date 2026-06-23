// Limitation: a non-JSON 4xx body (e.g. Cloudflare HTML 403) will NOT be an
// `ErrorResponse` with `data.code`; the broadened status branch
// (`>= 400 && < 500 && !== 429`) is what makes such cases classify permanent.
// If dfx ever fails to decode a 4xx into ErrorResponse at all (so it arrives
// as a plain HttpClientError), it would be treated transient — acceptable
// backstop given retries.

import { describe, expect, it } from 'vitest';
import { isPermanentError } from '~/rcp/channel/ProcessorService.js';

// ---------------------------------------------------------------------------
// Fake Discord error shapes (mirroring dfx DiscordREST Generated.d.ts)
// ---------------------------------------------------------------------------

const makeErrorResponse = (code: number, status: number) =>
  ({
    _tag: 'ErrorResponse',
    data: { code, message: `Discord error ${code}` },
    response: { status },
    request: {},
  }) as any;

// A sparse ErrorResponse with absent status (to test code-branch only)
const makeCodeOnlyErrorResponse = (code: number) =>
  ({
    _tag: 'ErrorResponse',
    data: { code, message: `Discord error ${code}` },
    response: {},
    request: {},
  }) as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isPermanentError', () => {
  // 1. Known Discord resource-not-found codes via status branch
  it('10007/404 (Unknown Member) → true', () => {
    expect(isPermanentError(makeErrorResponse(10007, 404))).toBe(true);
  });

  it('10008/404 (Unknown Message) → true', () => {
    expect(isPermanentError(makeErrorResponse(10008, 404))).toBe(true);
  });

  // 3. Missing permissions
  it('50013/403 (Missing Permissions) → true', () => {
    expect(isPermanentError(makeErrorResponse(50013, 403))).toBe(true);
  });

  // 4–6. Generic code 0 with non-429 4xx status (status branch)
  it('code 0 / 403 → true (non-429 4xx via status branch)', () => {
    expect(isPermanentError(makeErrorResponse(0, 403))).toBe(true);
  });

  it('code 0 / 404 → true (non-429 4xx via status branch)', () => {
    expect(isPermanentError(makeErrorResponse(0, 404))).toBe(true);
  });

  it('code 0 / 400 → true (any non-429 4xx is permanent)', () => {
    expect(isPermanentError(makeErrorResponse(0, 400))).toBe(true);
  });

  // 7. 5xx arrives as a plain HttpClientError (dfx `unexpectedStatus`) — NOT an ErrorResponse
  it('5xx HttpClientError (_tag !== ErrorResponse) → false (stays transient)', () => {
    const err = {
      _tag: 'HttpClientError',
      reason: { _tag: 'StatusCodeError' },
      response: { status: 500 },
    } as any;
    expect(isPermanentError(err)).toBe(false);
  });

  // 8. RatelimitedResponse (429) — _tag is RatelimitedResponse, not ErrorResponse
  it('RatelimitedResponse / 429 → false', () => {
    const err = {
      _tag: 'RatelimitedResponse',
      data: { code: 0, retry_after: 1.5, global: false, message: 'rate limited' },
      response: { status: 429 },
    } as any;
    expect(isPermanentError(err)).toBe(false);
  });

  // 9. RequestError (network error — no data/response)
  it('{ _tag: RequestError } (no data/response) → false', () => {
    expect(isPermanentError({ _tag: 'RequestError' } as any)).toBe(false);
  });

  // 10. Structural/parse errors are permanent
  it('{ _tag: ParseError } → true', () => {
    expect(isPermanentError({ _tag: 'ParseError' } as any)).toBe(true);
  });

  it('{ _tag: SchemaError } → true', () => {
    expect(isPermanentError({ _tag: 'SchemaError' } as any)).toBe(true);
  });

  // 11. Primitives and null
  it('null → false', () => {
    expect(isPermanentError(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isPermanentError(undefined)).toBe(false);
  });

  it('"string" → false', () => {
    expect(isPermanentError('some error string')).toBe(false);
  });

  it('42 → false', () => {
    expect(isPermanentError(42)).toBe(false);
  });

  // 12. Discord-code range boundaries (absent/non-4xx status → only code branch fires)
  it('code 10000 / absent status → true (lower boundary of 10xxx range)', () => {
    expect(isPermanentError(makeCodeOnlyErrorResponse(10000))).toBe(true);
  });

  it('code 10999 / absent status → true (upper boundary of 10xxx range)', () => {
    expect(isPermanentError(makeCodeOnlyErrorResponse(10999))).toBe(true);
  });

  it('code 11000 / absent status → false (just outside 10xxx range)', () => {
    expect(isPermanentError(makeCodeOnlyErrorResponse(11000))).toBe(false);
  });

  it('code 9999 / absent status → false (just below 10xxx range)', () => {
    expect(isPermanentError(makeCodeOnlyErrorResponse(9999))).toBe(false);
  });
});
