import { DateTime } from 'effect';
import { describe, expect, it } from 'vitest';
import { resolveOccurrenceInstant } from '~/utils/seriesOccurrence.js';

describe('resolveOccurrenceInstant', () => {
  // THE bug this whole fix exists for: a recurring "Tuesday 18:00" is a
  // wall-clock time, not a UTC time-of-day. No single UTC offset equals
  // 18:00 Prague-local all year — a naive `${date}T${time}Z` materialization
  // (the pre-fix behaviour) always resolves to `...T18:00:00.000Z`
  // regardless of `dateStr`, which is an hour late in summer (CEST, UTC+2)
  // relative to the correct 16:00Z, even though it happens to be right in
  // winter (CET, UTC+1) by coincidence.
  it('THE REGRESSION: same wall-clock series time resolves to different UTC instants across the DST boundary (Prague)', () => {
    const winter = resolveOccurrenceInstant('2026-01-13', '18:00', 'Europe/Prague');
    const summer = resolveOccurrenceInstant('2026-07-14', '18:00', 'Europe/Prague');

    expect(winter.epochMilliseconds).toBe(Date.parse('2026-01-13T17:00:00.000Z'));
    expect(summer.epochMilliseconds).toBe(Date.parse('2026-07-14T16:00:00.000Z'));
    // Non-vacuity: if a regression reintroduces the naive `${date}T${time}Z`
    // materialization, both instants collapse to the (wrong) same time-of-day
    // and this equality fails to distinguish anything — assert they differ.
    expect(winter.epochMilliseconds).not.toBe(summer.epochMilliseconds);
  });

  it('accepts both HH:MM and HH:MM:SS (PG TIME may come back with seconds)', () => {
    const withoutSeconds = resolveOccurrenceInstant('2026-01-13', '18:00', 'Europe/Prague');
    const withSeconds = resolveOccurrenceInstant('2026-01-13', '18:00:00', 'Europe/Prague');

    expect(withSeconds.epochMilliseconds).toBe(withoutSeconds.epochMilliseconds);
    expect(withSeconds.epochMilliseconds).toBe(Date.parse('2026-01-13T17:00:00.000Z'));
  });

  it('falls back to Europe/Prague for an invalid IANA timezone instead of throwing', () => {
    // A cron that dies on one bad `team_settings.timezone` row must not stop
    // generating events for every other team.
    expect(() => resolveOccurrenceInstant('2026-01-13', '18:00', 'Mars/Olympus')).not.toThrow();

    const fallback = resolveOccurrenceInstant('2026-01-13', '18:00', 'Mars/Olympus');
    const pragueDirect = resolveOccurrenceInstant('2026-01-13', '18:00', 'Europe/Prague');
    expect(fallback.epochMilliseconds).toBe(pragueDirect.epochMilliseconds);
    expect(fallback.epochMilliseconds).toBe(Date.parse('2026-01-13T17:00:00.000Z'));
  });

  // Both occurrences are compared against "wall clock read as if it were
  // already UTC" (`Date.parse(<date>T<time>Z)`), which factors out the
  // ~6-month gap between the two calendar dates and leaves just the
  // zone's UTC *offset* for that date — that offset is what must (or must
  // not) move across the year, not the raw epoch delta between two
  // different dates.
  const offsetMs = (dateStr: string, timeStr: string, resolved: { epochMilliseconds: number }) =>
    Date.parse(`${dateStr}T${timeStr}:00Z`) - resolved.epochMilliseconds;

  it('UTC team: the offset never moves across the year', () => {
    const winter = resolveOccurrenceInstant('2026-01-13', '18:00', 'UTC');
    const summer = resolveOccurrenceInstant('2026-07-14', '18:00', 'UTC');

    expect(winter.epochMilliseconds).toBe(Date.parse('2026-01-13T18:00:00.000Z'));
    expect(summer.epochMilliseconds).toBe(Date.parse('2026-07-14T18:00:00.000Z'));
    expect(offsetMs('2026-01-13', '18:00', winter)).toBe(0);
    expect(offsetMs('2026-07-14', '18:00', summer)).toBe(0);
  });

  it('Pacific/Auckland (southern hemisphere): DST runs the opposite direction from Prague', () => {
    // NZ is on daylight time (NZDT, UTC+13) in January and standard time
    // (NZST, UTC+12) in July — the exact reverse of Prague's CET/CEST
    // calendar. A hardcoded "northern hemisphere DST window" assumption
    // would get this backwards.
    const january = resolveOccurrenceInstant('2026-01-13', '18:00', 'Pacific/Auckland');
    const july = resolveOccurrenceInstant('2026-07-14', '18:00', 'Pacific/Auckland');

    expect(january.epochMilliseconds).toBe(Date.parse('2026-01-13T05:00:00.000Z'));
    expect(july.epochMilliseconds).toBe(Date.parse('2026-07-14T06:00:00.000Z'));
    const januaryOffset = offsetMs('2026-01-13', '18:00', january);
    const julyOffset = offsetMs('2026-07-14', '18:00', july);
    expect(januaryOffset).toBe(13 * 60 * 60 * 1000);
    expect(julyOffset).toBe(12 * 60 * 60 * 1000);
    // January (DST/NZDT, UTC+13) is one hour AHEAD of July (standard/NZST,
    // UTC+12) — the opposite sign of the Prague case above, where the winter
    // occurrence's offset is one hour BEHIND the summer one's.
    expect(januaryOffset - julyOffset).toBe(60 * 60 * 1000);
  });

  it('Australia/Lord_Howe: a 30-minute DST shift, not a whole hour', () => {
    // Lord Howe Island is UTC+10:30 standard / UTC+11:00 DST — any code that
    // assumes DST always shifts by a whole hour is off by 30 minutes here.
    const summerDst = resolveOccurrenceInstant('2026-01-13', '18:00', 'Australia/Lord_Howe');
    const winterStandard = resolveOccurrenceInstant('2026-07-14', '18:00', 'Australia/Lord_Howe');

    expect(summerDst.epochMilliseconds).toBe(Date.parse('2026-01-13T07:00:00.000Z'));
    expect(winterStandard.epochMilliseconds).toBe(Date.parse('2026-07-14T07:30:00.000Z'));
    const summerOffset = offsetMs('2026-01-13', '18:00', summerDst);
    const winterOffset = offsetMs('2026-07-14', '18:00', winterStandard);
    expect(summerOffset).toBe(11 * 60 * 60 * 1000);
    expect(winterOffset).toBe(10.5 * 60 * 60 * 1000);
    expect(summerOffset - winterOffset).toBe(30 * 60 * 1000);
  });

  // The implementation's doc comment states it relies on effect-ts's default
  // "compatible" `DateTime.setParts` disambiguation for both the spring
  // gap and the autumn ambiguity. These two tests pin the CONCRETE resulting
  // epoch millis so that policy is asserted, not merely exercised — a future
  // effect-ts upgrade or refactor that silently switches disambiguation mode
  // (e.g. to "earlier"/"later"/"reject") will be caught here.
  it('DST gap (2026-03-29 CET->CEST, Prague): "compatible" pushes 02:30 forward by the gap size, landing at 01:30Z (as if 03:30 local)', () => {
    const resolved = resolveOccurrenceInstant('2026-03-29', '02:30', 'Europe/Prague');
    expect(resolved.epochMilliseconds).toBe(Date.parse('2026-03-29T01:30:00.000Z'));
  });

  it('DST ambiguity (2026-10-25 CEST->CET, Prague): "compatible" picks the EARLIER (still-DST, UTC+2) occurrence of the repeated 02:30, landing at 00:30Z', () => {
    const resolved = resolveOccurrenceInstant('2026-10-25', '02:30', 'Europe/Prague');
    expect(resolved.epochMilliseconds).toBe(Date.parse('2026-10-25T00:30:00.000Z'));
    // The later (CET, UTC+1) reading of the same wall-clock time would be
    // 01:30Z — assert we did NOT pick that one.
    expect(resolved.epochMilliseconds).not.toBe(Date.parse('2026-10-25T01:30:00.000Z'));
  });

  // Regression: the first implementation anchored on `${dateStr}T00:00:00Z` and then `setParts`.
  // Midnight UTC is the PREVIOUS day west of UTC, so the anchor's day-of-month was 31 whenever
  // `dateStr` was the 1st; `setParts` assigns year -> month -> day, so setting a short month
  // overflowed before the day was corrected and the occurrence silently landed a MONTH late:
  //
  //     America/New_York, asked 2026-02-01 18:00 -> got 2026-03-01 18:00
  //
  // Prague, UTC, Auckland and Lord_Howe are all unaffected (non-negative offsets), which is
  // exactly why the original test table missed it. This sweeps EVERY zone the platform will
  // accept — `TeamSettingsApi` validates against `isValidIanaTimezone` and the settings UI offers
  // the full `Intl.supportedValuesOf('timeZone')` list — on the 1st of each month plus a
  // month-end, so no zone can regress here again.
  it('preserves the requested calendar date and wall clock in EVERY IANA zone, including negative offsets', () => {
    const readBack = (instant: DateTime.Utc, timeZone: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(Number(DateTime.toEpochMillis(instant))));

    const dates = [
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2026-12-31',
    ];

    const mismatches: Array<string> = [];
    for (const timeZone of Intl.supportedValuesOf('timeZone')) {
      for (const date of dates) {
        const got = readBack(resolveOccurrenceInstant(date, '18:00', timeZone), timeZone);
        if (got !== `${date}, 18:00`) mismatches.push(`${timeZone} ${date} -> ${got}`);
      }
    }
    expect(mismatches).toStrictEqual([]);
  });
});
