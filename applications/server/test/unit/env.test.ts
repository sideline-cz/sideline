// Should-fix 6 (whole-series review of commit 46806427): `DISCORD_JOIN_ENFORCEMENT_ENABLED` is
// the incident-response kill switch for the Discord-join enforcement redirect. Before this fix,
// `Schema.Literals(['true', 'false'])` made `createEnv` FAIL BOOT for `1`, `TRUE`, `yes`, or any
// other ordinary boolean-ish spelling — the worst possible failure mode for a flag whose entire
// purpose is "flip this fast during an incident". `parseDiscordJoinEnforcementEnabled` is the
// permissive, case-insensitive parser that replaced schema validation for this field; it must
// never throw, and an unrecognised value must default to disabled (the safe direction), not
// crash the process.

import { describe, expect, it, vi } from 'vitest';
import { parseDiscordJoinEnforcementEnabled } from '~/env.js';

describe('parseDiscordJoinEnforcementEnabled (should-fix 6)', () => {
  it.each(['true', 'True', 'TRUE', '1', 'yes', 'YES', 'on', 'On'])(
    'treats %s as enabled',
    (value) => {
      expect(parseDiscordJoinEnforcementEnabled(value)).toBe(true);
    },
  );

  it.each(['false', 'False', 'FALSE', '0', 'no', 'NO', 'off', 'Off', ''])(
    'treats %s as disabled',
    (value) => {
      expect(parseDiscordJoinEnforcementEnabled(value)).toBe(false);
    },
  );

  it('tolerates surrounding whitespace', () => {
    expect(parseDiscordJoinEnforcementEnabled('  true  ')).toBe(true);
    expect(parseDiscordJoinEnforcementEnabled('  false  ')).toBe(false);
  });

  it('defaults an unrecognised value to disabled instead of throwing', () => {
    expect(() => parseDiscordJoinEnforcementEnabled('enabled-please')).not.toThrow();
    expect(parseDiscordJoinEnforcementEnabled('enabled-please')).toBe(false);
  });

  it('logs a warning (does not fail silently) for an unrecognised value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    parseDiscordJoinEnforcementEnabled('maybe');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('DISCORD_JOIN_ENFORCEMENT_ENABLED');
    warnSpy.mockRestore();
  });

  it('never throws regardless of input — the incident lever must never crash boot', () => {
    for (const value of ['', 'garbage', '  ', 'null', 'undefined', '2']) {
      expect(() => parseDiscordJoinEnforcementEnabled(value)).not.toThrow();
    }
  });
});
