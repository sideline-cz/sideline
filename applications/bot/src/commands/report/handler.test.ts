import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { reportTypeFromOption } from './handler.js';

describe('reportTypeFromOption', () => {
  it('reads the two choices Discord can send', () => {
    expect(reportTypeFromOption(Option.some('bug'))).toBe('bug');
    expect(reportTypeFromOption(Option.some('feature'))).toBe('feature');
  });

  it('falls back to a bug report for a missing or unknown value', () => {
    expect(reportTypeFromOption(Option.none())).toBe('bug');
    expect(reportTypeFromOption(Option.some('nonsense'))).toBe('bug');
  });
});
