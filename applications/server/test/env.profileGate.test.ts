// Task 3 (`.work-plans/discord-full-onboarding.md`) — `PROFILE_GATE_ENABLED` is the global
// incident lever for the profile-completeness gate (RSVP / training claim / carpool seat).
// Modelled on `parseDiscordJoinEnforcementEnabled` (`env.test.ts`), with ONE deliberate deviation
// pinned here: the safe direction for THIS flag is `true` (the per-team
// `team_settings.require_complete_profile` column, DEFAULT false, is the real off switch — see
// the plan's "Rollout: two levers"). An unset env var must decode to the schema default `'true'`,
// and `''` must NOT be in the FALSY set, or a deploy with no `PROFILE_GATE_ENABLED` set at all
// would silently invert the documented default. This file pins exactly that regression.
//
// `parseProfileGateEnabled` does not exist yet — this import fails module resolution until Task 3
// adds it to `~/env.js`. That is the expected first shape of "red" for this file.

import { describe, expect, it, vi } from 'vitest';
import { parseProfileGateEnabled } from '~/env.js';

describe('parseProfileGateEnabled (Task 3 — profile gate incident lever)', () => {
  it.each(['true', 'True', 'TRUE', '1', 'yes', 'YES', 'on', 'On'])(
    'treats %s as enabled',
    (value) => {
      expect(parseProfileGateEnabled(value)).toBe(true);
    },
  );

  it.each(['false', 'False', 'FALSE', '0', 'no', 'NO', 'off', 'Off'])(
    'treats %s as disabled',
    (value) => {
      expect(parseProfileGateEnabled(value)).toBe(false);
    },
  );

  it('tolerates surrounding whitespace', () => {
    expect(parseProfileGateEnabled('  true  ')).toBe(true);
    expect(parseProfileGateEnabled('  false  ')).toBe(false);
  });

  // The regression this file exists to pin: the copied parser's FALSY set (from
  // `parseDiscordJoinEnforcementEnabled`) includes `''`, because THAT flag's safe direction is
  // disabled. This flag's safe direction is the opposite, so `''` — what an env var that was
  // never set decodes to before `Schemas.Optional(() => 'true')` even applies its own default —
  // must resolve to `true`, not fall through to a copy-pasted FALSY entry.
  it("does NOT treat '' as disabled — an unset variable must default to enabled, not invert it", () => {
    expect(parseProfileGateEnabled('')).toBe(true);
  });

  it('defaults an unrecognised value to enabled (the safe direction for this flag) instead of throwing', () => {
    expect(() => parseProfileGateEnabled('enabled-please')).not.toThrow();
    expect(parseProfileGateEnabled('enabled-please')).toBe(true);
  });

  it('logs a warning for an unrecognised value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    parseProfileGateEnabled('banana');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('PROFILE_GATE_ENABLED');
    warnSpy.mockRestore();
  });

  it('never throws regardless of input', () => {
    for (const value of ['', 'garbage', '  ', 'null', 'undefined', '2']) {
      expect(() => parseProfileGateEnabled(value)).not.toThrow();
    }
  });
});
