import { describe, expect, it } from '@effect/vitest';
import { reportTypeFromCustomId } from './report.js';

describe('reportTypeFromCustomId', () => {
  it('round-trips the custom_id the command builds', () => {
    expect(reportTypeFromCustomId('report:bug')).toBe('bug');
    expect(reportTypeFromCustomId('report:feature')).toBe('feature');
  });

  it('falls back to a bug report for a malformed custom_id', () => {
    expect(reportTypeFromCustomId('report:')).toBe('bug');
    expect(reportTypeFromCustomId('report')).toBe('bug');
  });
});
