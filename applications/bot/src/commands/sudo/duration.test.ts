// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { describe, expect, it } from 'vitest';
import { formatSudoDuration } from '~/commands/sudo/duration.js';

describe('formatSudoDuration', () => {
  it('zero elapsed → "0s"', () => {
    expect(formatSudoDuration(0)).toBe('0s');
  });

  it('negative elapsed → "0s"', () => {
    expect(formatSudoDuration(-1000)).toBe('0s');
  });

  it('exact hour → "2h" (no minutes suffix)', () => {
    expect(formatSudoDuration(2 * 60 * 60 * 1000)).toBe('2h');
  });

  it('hour + minutes → "2h 15m" (seconds dropped once minutes shown with hours)', () => {
    expect(formatSudoDuration((2 * 60 * 60 + 15 * 60) * 1000)).toBe('2h 15m');
  });

  it('minutes + seconds → "45m 12s"', () => {
    expect(formatSudoDuration((45 * 60 + 12) * 1000)).toBe('45m 12s');
  });

  it('seconds only → "3s"', () => {
    expect(formatSudoDuration(3 * 1000)).toBe('3s');
  });
});
