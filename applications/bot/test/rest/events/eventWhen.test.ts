// TDD mode — `~/rest/events/eventWhen.js` does not exist yet (PR 1 of the all-day-event
// Discord-render fix). Every test below is expected to fail with a module-resolution error
// until the file is created per the plan's §4.2/§4.3.
//
// Plan: all-day-discord-start-time-plan.md — §4.2 (shape), §4.3 (byte-exact contract),
// §7.1 (this file's Part I spec), §11.4 + §18 §7.1 (the startDate/endDate string inputs
// and the skew fallback case).
//
// IMPORTANT — the all-day branch takes DATES, not instants (§11.4, v4 override of §4.3's
// rationale). `EventWhen` therefore carries BOTH `startAt`/`endAt` (DateTime.Utc — used by
// the timed branch and as the skew fallback) AND `startDate`/`endDate` (string — used by
// the all-day branch via `discordDateInstant`). PR 1 always derives startDate/endDate from
// startAt/endAt with `DateTime.formatIsoDateUtc`; PR 2/3b later swap in the payload's real
// date fields — the EventWhen signature itself does not change again.

import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type EventWhen,
  formatEventWhen,
  formatEventWhenLong,
  isSameUtcDay,
} from '~/rest/events/eventWhen.js';

// ---------------------------------------------------------------------------
// Fixtures — epoch seconds pre-computed and asserted literally, per the plan.
// ---------------------------------------------------------------------------

const START_16 = DateTime.makeUnsafe('2026-07-15T16:00:00Z'); // 1784131200
const END_18_SAME_DAY = DateTime.makeUnsafe('2026-07-15T18:00:00Z'); // 1784138400
const START_22 = DateTime.makeUnsafe('2026-07-15T22:00:00Z'); // 1784152800
const END_NEXT_01 = DateTime.makeUnsafe('2026-07-16T01:00:00Z'); // 1784163600
const NOON_JUL_15 = DateTime.makeUnsafe('2026-07-15T12:00:00Z'); // 1784116800
const NOON_JUL_17 = DateTime.makeUnsafe('2026-07-17T12:00:00Z'); // 1784289600
const NOON_JAN_15 = DateTime.makeUnsafe('2026-01-15T12:00:00Z'); // 1768478400

const AD_EN = ' · All day';
const AD_CS = ' · Celý den';

/** Builds an EventWhen, deriving startDate/endDate the way PR 1's call sites do
 * (DateTime.formatIsoDateUtc), which is what makes the all-day branch correct under
 * the still-noon-anchored storage that PR 1 ships against. */
const makeWhen = (opts: {
  startAt: DateTime.Utc;
  endAt?: Option.Option<DateTime.Utc>;
  allDay: boolean;
  locale?: 'en' | 'cs';
}): EventWhen => {
  const endAt = opts.endAt ?? Option.none();
  return {
    startAt: opts.startAt,
    startDate: DateTime.formatIsoDateUtc(opts.startAt),
    endAt,
    endDate: Option.map(endAt, DateTime.formatIsoDateUtc),
    allDay: opts.allDay,
    locale: opts.locale ?? 'en',
  };
};

describe('formatEventWhen', () => {
  // #1 — timed, no end
  it('timed, no end → <t:S:f>', () => {
    expect(formatEventWhen(makeWhen({ startAt: START_16, allDay: false }))).toBe(
      '<t:1784131200:f>',
    );
  });

  // #2 — timed, end same UTC day
  it('timed, end same UTC day → <t:S:f> — <t:E:t>', () => {
    expect(
      formatEventWhen(
        makeWhen({ startAt: START_16, endAt: Option.some(END_18_SAME_DAY), allDay: false }),
      ),
    ).toBe('<t:1784131200:f> — <t:1784138400:t>');
  });

  // #3 — timed, end next UTC day
  it('timed, end next UTC day → <t:S:f> — <t:E:f>', () => {
    expect(
      formatEventWhen(
        makeWhen({ startAt: START_22, endAt: Option.some(END_NEXT_01), allDay: false }),
      ),
    ).toBe('<t:1784152800:f> — <t:1784163600:f>');
  });

  // #4 — all-day, no end, en
  it('all-day, no end, en → <t:S:D> · All day', () => {
    expect(formatEventWhen(makeWhen({ startAt: NOON_JUL_15, allDay: true }))).toBe(
      `<t:1784116800:D>${AD_EN}`,
    );
  });

  // #5 — all-day, end same day (start === end)
  it('all-day, end === start → <t:S:D> · All day (no dash)', () => {
    expect(
      formatEventWhen(
        makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_15), allDay: true }),
      ),
    ).toBe(`<t:1784116800:D>${AD_EN}`);
  });

  // #6 — all-day, multi-day
  it('all-day, multi-day → <t:S:D> — <t:E:D> · All day', () => {
    expect(
      formatEventWhen(
        makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_17), allDay: true }),
      ),
    ).toBe(`<t:1784116800:D> — <t:1784289600:D>${AD_EN}`);
  });

  // #7 — all-day, cs locale
  it('all-day, cs locale → <t:S:D> · Celý den', () => {
    expect(formatEventWhen(makeWhen({ startAt: NOON_JUL_15, allDay: true, locale: 'cs' }))).toBe(
      `<t:1784116800:D>${AD_CS}`,
    );
  });

  // #8 — winter (CET) all-day — proves no local-day shift
  it('winter (CET) all-day → <t:S:D> · All day, no local-day shift', () => {
    expect(formatEventWhen(makeWhen({ startAt: NOON_JAN_15, allDay: true }))).toBe(
      `<t:1768478400:D>${AD_EN}`,
    );
  });

  // #9 — all-day, end_at BEFORE start_at (bad data) → single-day fallback, never inverted
  it('all-day, end before start (bad data) → single-day fallback, never an inverted range', () => {
    expect(
      formatEventWhen(
        makeWhen({ startAt: NOON_JUL_17, endAt: Option.some(NOON_JUL_15), allDay: true }),
      ),
    ).toBe(`<t:1784289600:D>${AD_EN}`);
  });

  // #10 — regression guard: cases 4–9 never emit F/f/R/t/d styles, and match the shape
  describe('regression guard — all-day output never uses F/f/R/t/d styles', () => {
    const allDayCases: ReadonlyArray<[string, EventWhen]> = [
      ['no end, en', makeWhen({ startAt: NOON_JUL_15, allDay: true })],
      [
        'end === start',
        makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_15), allDay: true }),
      ],
      [
        'multi-day',
        makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_17), allDay: true }),
      ],
      ['cs locale', makeWhen({ startAt: NOON_JUL_15, allDay: true, locale: 'cs' })],
      ['winter (CET)', makeWhen({ startAt: NOON_JAN_15, allDay: true })],
      [
        'end before start',
        makeWhen({ startAt: NOON_JUL_17, endAt: Option.some(NOON_JUL_15), allDay: true }),
      ],
    ];

    for (const [label, when] of allDayCases) {
      it(`${label}: matches the invariant regex and contains no F/f/R/t/d style`, () => {
        const out = formatEventWhen(when);
        expect(out).not.toMatch(/<t:\d+:[FfRtd]>/);
        expect(out).toMatch(/^<t:\d+:D>(?: — <t:\d+:D>)? · .+$/);
      });
    }
  });

  // §18 §7.1 skew case — the caller received Option.none() for the payload's real
  // start_date/end_date (old server, new client) and fell back to
  // DateTime.formatIsoDateUtc(entry.start_at) per §17.1 row 2. Output must be
  // byte-identical to the non-skew case for a noon-UTC start_at.
  it('skew fallback: startDate derived via DateTime.formatIsoDateUtc renders identically to the non-skew case', () => {
    const skewFallbackWhen: EventWhen = {
      startAt: NOON_JUL_15,
      startDate: DateTime.formatIsoDateUtc(NOON_JUL_15), // caller's Option.none() fallback
      endAt: Option.none(),
      endDate: Option.none(),
      allDay: true,
      locale: 'en',
    };
    const nonSkewWhen = makeWhen({ startAt: NOON_JUL_15, allDay: true });
    expect(formatEventWhen(skewFallbackWhen)).toBe(formatEventWhen(nonSkewWhen));
    expect(formatEventWhen(skewFallbackWhen)).toBe(`<t:1784116800:D>${AD_EN}`);
  });
});

describe('formatEventWhenLong', () => {
  // #11 — timed, no end
  it('timed, no end → <t:S:F>', () => {
    expect(formatEventWhenLong(makeWhen({ startAt: START_16, allDay: false }))).toBe(
      '<t:1784131200:F>',
    );
  });

  // #12 — timed, WITH end → end is IGNORED; byte-identical to today's handleStarted.ts:82.
  // This is the single most likely regression: handleStarted must never grow an end range.
  it('timed, WITH end → end is ignored, byte-identical to <t:S:F> alone', () => {
    expect(
      formatEventWhenLong(
        makeWhen({ startAt: START_16, endAt: Option.some(END_18_SAME_DAY), allDay: false }),
      ),
    ).toBe('<t:1784131200:F>');
  });

  // #13 — all-day, no end
  it('all-day, no end → <t:S:D> · All day', () => {
    expect(formatEventWhenLong(makeWhen({ startAt: NOON_JUL_15, allDay: true }))).toBe(
      `<t:1784116800:D>${AD_EN}`,
    );
  });

  // #14 — all-day, multi-day
  it('all-day, multi-day → <t:S:D> — <t:E:D> · All day', () => {
    expect(
      formatEventWhenLong(
        makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_17), allDay: true }),
      ),
    ).toBe(`<t:1784116800:D> — <t:1784289600:D>${AD_EN}`);
  });

  // Regression guard for the long formatter too — same invariant as formatEventWhen.
  it('all-day output never uses F/f/R/t/d styles', () => {
    const out = formatEventWhenLong(
      makeWhen({ startAt: NOON_JUL_15, endAt: Option.some(NOON_JUL_17), allDay: true }),
    );
    expect(out).not.toMatch(/<t:\d+:[FfRtd]>/);
    expect(out).toMatch(/^<t:\d+:D>(?: — <t:\d+:D>)? · .+$/);
  });
});

describe('isSameUtcDay', () => {
  // #15
  it('22:00Z vs next-day 01:00Z → false', () => {
    expect(isSameUtcDay(START_22, END_NEXT_01)).toBe(false);
  });

  // #16
  it('12:00Z vs 18:00Z same date → true', () => {
    expect(isSameUtcDay(NOON_JUL_15, END_18_SAME_DAY)).toBe(true);
  });
});
