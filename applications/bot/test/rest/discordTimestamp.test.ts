// TDD mode — `~/rest/discordTimestamp.js` does not exist yet (PR 1 of the all-day-event
// Discord-render fix). Every test below is expected to fail with a module-resolution error
// until the file is created per the plan's §4.1 (and §11.4/§18 for `discordDateInstant`).
//
// Plan: all-day-discord-start-time-plan.md — §4.1 (primitive), §7.2 (this file's Part I
// spec), §11.4 + §18 §7.2/§7.2b (the `discordDateInstant` additions).

import { DateTime } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type DiscordTimestampStyle,
  discordDateInstant,
  discordTimestampFromEpochSeconds,
  toDiscordTimestamp,
} from '~/rest/discordTimestamp.js';

const EPOCH_2026_07_15_NOON = 1784116800; // 2026-07-15T12:00:00Z

describe('discordTimestampFromEpochSeconds / toDiscordTimestamp', () => {
  // §7.2 case 1 — every style renders <t:EPOCH:STYLE>
  const styles: ReadonlyArray<DiscordTimestampStyle> = ['D', 'F', 'R', 'd', 'f', 't'];
  for (const style of styles) {
    it(`renders <t:${EPOCH_2026_07_15_NOON}:${style}> for style "${style}"`, () => {
      expect(toDiscordTimestamp(DateTime.makeUnsafe('2026-07-15T12:00:00Z'), style)).toBe(
        `<t:${EPOCH_2026_07_15_NOON}:${style}>`,
      );
    });
  }

  // §7.2 case 2 — default style is `f`
  it('defaults to style "f" when none is passed', () => {
    expect(toDiscordTimestamp(DateTime.makeUnsafe('2026-07-15T12:00:00Z'))).toBe(
      `<t:${EPOCH_2026_07_15_NOON}:f>`,
    );
  });

  // §7.2 case 3 — sub-second inputs floor, not round
  it('floors sub-second instants rather than rounding', () => {
    expect(toDiscordTimestamp(DateTime.makeUnsafe('2026-07-15T12:00:00.999Z'), 'f')).toBe(
      `<t:${EPOCH_2026_07_15_NOON}:f>`,
    );
  });

  // §7.2 case 4 — the epoch-seconds companion, directly
  it('discordTimestampFromEpochSeconds(1784116800, "D") renders <t:1784116800:D>', () => {
    expect(discordTimestampFromEpochSeconds(1784116800, 'D')).toBe('<t:1784116800:D>');
  });

  it('discordTimestampFromEpochSeconds defaults to style "f" too', () => {
    expect(discordTimestampFromEpochSeconds(1784116800)).toBe('<t:1784116800:f>');
  });
});

// ---------------------------------------------------------------------------
// §18 §7.2 — discordDateInstant: the total helper that reconstructs a Discord
// display instant (12:00:00Z of the intended calendar date) from a date-only
// string, falling back rather than throwing on malformed input.
// ---------------------------------------------------------------------------

describe('discordDateInstant', () => {
  const fallback = DateTime.makeUnsafe('2020-01-01T00:00:00Z');

  it('anchors a valid date-only string at 12:00:00Z of that date', () => {
    const result = discordDateInstant('2026-07-15', fallback);
    expect(Math.floor(Number(DateTime.toEpochMillis(result)) / 1000)).toBe(EPOCH_2026_07_15_NOON);
    expect(toDiscordTimestamp(result, 'D')).toBe(`<t:${EPOCH_2026_07_15_NOON}:D>`);
  });

  // TOTALITY — this is the load-bearing case. `DateTime.makeUnsafe` THROWS on a
  // malformed input (measured at effect@4.0.0-beta.40); on the personal-message
  // reconcile path a thrown IllegalArgumentError becomes a defect that can take out
  // a whole sweep. `discordDateInstant` must never throw — it must fall back.
  it('falls back to fallbackInstant, and does NOT throw, for a malformed date string', () => {
    expect(() => discordDateInstant('not-a-date', fallback)).not.toThrow();
    const result = discordDateInstant('not-a-date', fallback);
    expect(DateTime.toEpochMillis(result)).toEqual(DateTime.toEpochMillis(fallback));
  });

  it('falls back to fallbackInstant for an empty string', () => {
    const result = discordDateInstant('', fallback);
    expect(DateTime.toEpochMillis(result)).toEqual(DateTime.toEpochMillis(fallback));
  });
});

// ---------------------------------------------------------------------------
// §18 NEW §7.2b — the display-instant property, and the documented exceptions.
//
// <t:E:D> renders in the VIEWER's zone. This table asserts the exact set of zones for
// which discordDateInstant('2026-07-15') renders 2026-07-15 — and the exact set for
// which it does not. All fifteen values were measured at commit dae1e880. Do NOT "fix"
// a documented-wrong (❌) row by moving the anchor off 12:00:00Z — see §11.5(b) of the
// plan: no single instant covers the full -12…+14 (26-hour) offset span, and moving the
// anchor to rescue +14 breaks -11, which has far more members. The ❌ rows here are a
// known, accepted limit, not a bug to fix later.
// ---------------------------------------------------------------------------

describe('discordDateInstant — the display-instant property over the full offset range', () => {
  const OK = '2026-07-15';
  const WRONG_BY_ONE_DAY = '2026-07-16'; // expected-wrong, documented (§11.5(b))

  const cases: ReadonlyArray<{ zone: string; offset: string; expected: string }> = [
    { zone: 'Etc/GMT+12', offset: '-12', expected: OK },
    { zone: 'Pacific/Honolulu', offset: '-10', expected: OK },
    { zone: 'America/New_York', offset: '-4', expected: OK },
    { zone: 'UTC', offset: '0', expected: OK },
    { zone: 'Europe/Prague', offset: '+2', expected: OK },
    { zone: 'Asia/Kolkata', offset: '+5:30', expected: OK },
    { zone: 'Asia/Kathmandu', offset: '+5:45', expected: OK },
    { zone: 'Asia/Tokyo', offset: '+9', expected: OK },
    { zone: 'Australia/Sydney', offset: '+10', expected: OK },
    // ❌ documented-wrong below — Discord renders D+1 for these viewers. Accepted limit.
    { zone: 'Pacific/Auckland', offset: '+12', expected: WRONG_BY_ONE_DAY },
    { zone: 'Pacific/Fiji', offset: '+12', expected: WRONG_BY_ONE_DAY },
    { zone: 'Asia/Kamchatka', offset: '+12', expected: WRONG_BY_ONE_DAY },
    { zone: 'Pacific/Chatham', offset: '+12:45', expected: WRONG_BY_ONE_DAY },
    { zone: 'Pacific/Apia', offset: '+13', expected: WRONG_BY_ONE_DAY },
    { zone: 'Pacific/Kiritimati', offset: '+14', expected: WRONG_BY_ONE_DAY },
  ];

  for (const { zone, offset, expected } of cases) {
    const verdict = expected === OK ? '✅' : '❌ expected-wrong, documented (§11.5(b))';
    it(`${zone} (${offset}) renders "${expected}" ${verdict}`, () => {
      const instant = discordDateInstant('2026-07-15', DateTime.makeUnsafe('1970-01-01T00:00:00Z'));
      const epochMs = Number(DateTime.toEpochMillis(instant));
      const rendered = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(
        new Date(epochMs),
      );
      // Not a pattern/contains check — the plan is explicit that an expected-wrong
      // assertion that a later change flips to right is a *passing* test that tells
      // you the anchor moved, so it must be pinned as a literal, not loosened.
      expect(rendered).toBe(expected);
    });
  }
});
