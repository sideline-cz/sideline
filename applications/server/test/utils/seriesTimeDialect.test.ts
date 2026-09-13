// TDD mode — Release N of the timezone-migration-deploy-window plan
// (`.work-plans/timezone-migration-deploy-window.md`, "Release N" §N.2/N.3
// and "Test Specification → Release N" §N.b).
//
// `applications/server/src/utils/seriesTimeDialect.ts` does not exist yet.
// Every test below is expected to fail at MODULE RESOLUTION (the whole file
// errors on import) until the developer creates it with these THREE exports:
//
//   - resolveSeriesOccurrenceInstant(dateStr, time, timezone, timesAreTeamLocal)
//   - seriesSqlZone(timezone, timesAreTeamLocal)
//   - assertDialectMatches(payloadIsTeamLocal, storageIsTeamLocal)  // Effect, fails on mismatch
//
// That import failure is the correct first shape of "red" here — it is not
// yet a statement about the dialect logic itself.
//
// `assertDialectMatches` is assumed (by this test file; confirm against the
// actual implementation once written) to fail with a tagged error shaped
// like `EventSeriesApi.EventSeriesNotActive` — the plan's own words: "the
// EventSeriesNotActive shape is the local precedent" — living alongside it
// in `@sideline/domain`'s `EventSeriesApi.ts` as `EventSeriesTimeDialectMismatch`,
// a no-field `Schema.TaggedErrorClass`. Corrected post-review (Fix 1):
// `assertDialectMatches` is called from the `updateEventSeries` handler ONLY — create has no
// existing row to assert a dialect against, so `EventSeriesTimeDialectMismatch` is registered
// only in `updateEventSeries`'s HTTP error union, not `createEventSeries`'s. If the real
// implementation names this error differently, only tests 6/7 below need
// their import/assertion updated — 1-5 are independent of that choice.

import { describe, expect, it } from '@effect/vitest';
import { EventSeriesApi } from '@sideline/domain';
import { Effect } from 'effect';
import {
  assertDialectMatches,
  resolveSeriesOccurrenceInstant,
  seriesSqlZone,
} from '~/utils/seriesTimeDialect.js';

describe('resolveSeriesOccurrenceInstant', () => {
  it('1. FALSE (UTC time-of-day dialect): Prague 2026-07-14 18:00 resolves to EXACTLY 18:00Z — the legacy `${date}T${time}Z` expression, byte for byte', () => {
    const result = resolveSeriesOccurrenceInstant('2026-07-14', '18:00', 'Europe/Prague', false);
    expect(result.epochMilliseconds).toBe(Date.parse('2026-07-14T18:00:00.000Z'));
  });

  it('2. TRUE (team-local dialect): the SAME Prague 2026-07-14 18:00 resolves to 16:00Z — one hour EARLIER than the FALSE case above, because of the Prague summer (CEST, UTC+2) offset', () => {
    const result = resolveSeriesOccurrenceInstant('2026-07-14', '18:00', 'Europe/Prague', true);
    expect(result.epochMilliseconds).toBe(Date.parse('2026-07-14T16:00:00.000Z'));
  });

  it('non-vacuity: the FALSE and TRUE results for the identical inputs differ (guards against a regression that collapses the branch)', () => {
    const utcDialect = resolveSeriesOccurrenceInstant(
      '2026-07-14',
      '18:00',
      'Europe/Prague',
      false,
    );
    const teamLocalDialect = resolveSeriesOccurrenceInstant(
      '2026-07-14',
      '18:00',
      'Europe/Prague',
      true,
    );
    expect(utcDialect.epochMilliseconds).not.toBe(teamLocalDialect.epochMilliseconds);
  });

  it("3. FALSE with an HH:MM:SS input (a Postgres TIME can come back with seconds) matches the pre-#650 template `${date}T${time}Z` byte for byte — resolveOccurrenceInstant's HH:MM:SS zero-padding/normalisation is new behaviour that must not leak into the legacy (FALSE) branch", () => {
    const time = '18:00:00';
    const result = resolveSeriesOccurrenceInstant('2026-07-14', time, 'Europe/Prague', false);
    expect(result.epochMilliseconds).toBe(Date.parse(`2026-07-14T${time}Z`));
    expect(result.epochMilliseconds).toBe(Date.parse('2026-07-14T18:00:00.000Z'));
  });

  it('4. FALSE with America/New_York (negative UTC offset) — the timezone argument is ignored entirely; result is byte-identical to the Europe/Prague case, because the FALSE dialect is UTC time-of-day regardless of team zone', () => {
    const prague = resolveSeriesOccurrenceInstant('2026-07-14', '18:00', 'Europe/Prague', false);
    const newYork = resolveSeriesOccurrenceInstant(
      '2026-07-14',
      '18:00',
      'America/New_York',
      false,
    );
    expect(newYork.epochMilliseconds).toBe(prague.epochMilliseconds);
    expect(newYork.epochMilliseconds).toBe(Date.parse('2026-07-14T18:00:00.000Z'));
  });
});

describe('seriesSqlZone', () => {
  it("5a. FALSE -> 'UTC' — a UTC-dialect series' events must be re-derived in UTC, never the team zone", () => {
    expect(seriesSqlZone('Europe/Prague', false)).toBe('UTC');
    expect(seriesSqlZone('America/New_York', false)).toBe('UTC');
  });

  it('5b. TRUE -> the team zone, verbatim', () => {
    expect(seriesSqlZone('Europe/Prague', true)).toBe('Europe/Prague');
    expect(seriesSqlZone('America/New_York', true)).toBe('America/New_York');
  });
});

describe('assertDialectMatches', () => {
  it.effect('6a. passes (succeeds with no error) when both are FALSE', () =>
    assertDialectMatches(false, false).pipe(Effect.map((result) => expect(result).toBeUndefined())),
  );

  it.effect('6b. passes (succeeds with no error) when both are TRUE', () =>
    assertDialectMatches(true, true).pipe(Effect.map((result) => expect(result).toBeUndefined())),
  );

  it.effect(
    '7a. fails with the tagged dialect-mismatch error when the payload declares TRUE against FALSE storage (a stale pre-#650 client would never trigger this; this is the N+1 straggler direction)',
    () =>
      assertDialectMatches(true, false).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(EventSeriesApi.EventSeriesTimeDialectMismatch);
            expect(error._tag).toBe('EventSeriesTimeDialectMismatch');
          }),
        ),
      ),
  );

  it.effect(
    '7b. fails with the tagged dialect-mismatch error when the payload declares FALSE against TRUE storage (the Release-N-server-created-row-then-N+1-migration-converts-it direction)',
    () =>
      assertDialectMatches(false, true).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(EventSeriesApi.EventSeriesTimeDialectMismatch);
            expect(error._tag).toBe('EventSeriesTimeDialectMismatch');
          }),
        ),
      ),
  );
});
