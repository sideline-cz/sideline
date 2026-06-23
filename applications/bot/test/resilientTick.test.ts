import { Cause } from 'effect';
import { describe, expect, it } from 'vitest';
import { isTransientPollError } from '~/Bot.js';

// ---------------------------------------------------------------------------
// Pure classifier tests
// ---------------------------------------------------------------------------

describe('isTransientPollError — pure classifier', () => {
  // 1. Die branch: SyntaxError instance whose message includes "is not valid JSON"
  it('Cause.die(SyntaxError with "is not valid JSON") → true', () => {
    const cause = Cause.die(
      new SyntaxError(
        'Unexpected token e in JSON at position 0 "error code: 502" is not valid JSON',
      ),
    );
    expect(isTransientPollError(cause)).toBe(true);
  });

  // 2. Fail branch: error object with message heuristic (covers SyntaxError arriving as typed failure)
  it('Cause.fail({ message: "... is not valid JSON" }) → true', () => {
    const cause = Cause.fail({ message: 'Unexpected token: "error code: 502" is not valid JSON' });
    expect(isTransientPollError(cause)).toBe(true);
  });

  // 3. Fail branch: 5xx status on a response error
  it('Cause.fail({ _tag: ResponseError, response: { status: 502 } }) → true', () => {
    const cause = Cause.fail({ _tag: 'ResponseError', response: { status: 502 } });
    expect(isTransientPollError(cause)).toBe(true);
  });

  // 4. Fail branch: arbitrary tagged app error — not a transient upstream blip
  it('Cause.fail({ _tag: EventPropertyMissing }) → false', () => {
    const cause = Cause.fail({ _tag: 'EventPropertyMissing' });
    expect(isTransientPollError(cause)).toBe(false);
  });

  // 5. Die branch: plain Error without JSON message — not transient
  it('Cause.die(new Error("boom")) → false', () => {
    const cause = Cause.die(new Error('boom'));
    expect(isTransientPollError(cause)).toBe(false);
  });

  // 6. Interrupt-only cause → false (shutdown, not an upstream blip)
  it('Cause.interrupt() → false', () => {
    const cause = Cause.interrupt();
    expect(isTransientPollError(cause)).toBe(false);
  });

  // Empty cause (no reasons) → false
  it('Cause.empty → false', () => {
    expect(isTransientPollError(Cause.empty)).toBe(false);
  });

  // 7. Multi-reason: combine a non-transient Fail with a transient Die → true (.some matches)
  it('Cause.combine(Cause.fail({ _tag: X }), Cause.die(SyntaxError "x is not valid JSON")) → true', () => {
    const cause = Cause.combine(
      Cause.fail({ _tag: 'X' }),
      Cause.die(new SyntaxError('x is not valid JSON')),
    );
    expect(isTransientPollError(cause)).toBe(true);
  });
});
