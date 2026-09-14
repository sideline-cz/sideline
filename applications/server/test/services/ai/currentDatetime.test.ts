// Spec for the `current_datetime` tool's pure time computation, `computeCurrentDatetime`
// (`src/services/ai/currentDatetime.ts`) — plan `.work-plans/ai-app-interaction.md` §8 / §13.5.
//
// Contract this file pins down: `computeCurrentDatetime(teamTimezone: string)` is an
// `Effect<CurrentDatetimeResult>` (no error channel, no extra requirements beyond the
// ambient `Clock`) so it is driven by `TestClock` exactly like `DateTime.now` is
// everywhere else in this codebase (see e.g. `src/services/WeeklySummaryCron.ts`).
//
//   interface CurrentDatetimeResult {
//     readonly nowUtcIso: string;
//     readonly teamTimezone: string;
//     readonly todayTeamLocal: string;   // YYYY-MM-DD, in `teamTimezone`
//     readonly nowTeamLocal: string;     // YYYY-MM-DDTHH:mm, in `teamTimezone`
//     readonly utcOffsetMinutes: number; // teamTimezone's offset from UTC at `nowUtcIso`
//   }
//
// Per `applications/server/AGENTS.md:1059` ("Building A Zoned Instant From Calendar +
// Clock Parts" / the zoned-instant-builder testing rule), the zone table below
// includes a negative-offset zone (`America/New_York`) and a non-whole-hour zone
// (`Asia/Kathmandu`, UTC+5:45) — a UTC-naive implementation is wrong for the FIRST
// one (it rolls the year forward) and a whole-hour approximation is wrong for the
// SECOND (it rolls the day forward). Every case also round-trips `nowUtcIso` back to
// the exact injected instant, so "todayTeamLocal happens to be right" can't hide a
// `nowUtcIso` that silently carries the LOCAL wall clock instead of the UTC instant.
//
// Deliberately excluded: a `2026-03-29T02:30` `Europe/Prague` case (spring-forward
// gap — that local time does not exist, and its resolution is implementation-defined,
// per the plan's own instruction not to use one here). DST is still covered
// non-vacuously by the two `Europe/Prague` rows below (`utcOffsetMinutes` 60 vs 120).

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { computeCurrentDatetime } from '~/services/ai/currentDatetime.js';

interface ZoneCase {
  readonly label: string;
  readonly zone: string;
  readonly instant: string; // ISO UTC instant fed to TestClock
  readonly todayTeamLocal: string;
  readonly nowTeamLocal: string;
  readonly utcOffsetMinutes: number;
}

const cases: ReadonlyArray<ZoneCase> = [
  {
    label: 'Europe/Prague, January (CET, baseline)',
    zone: 'Europe/Prague',
    instant: '2026-01-15T12:00:00.000Z',
    todayTeamLocal: '2026-01-15',
    nowTeamLocal: '2026-01-15T13:00',
    utcOffsetMinutes: 60,
  },
  {
    label: 'Europe/Prague, July (CEST — DST is observed)',
    zone: 'Europe/Prague',
    instant: '2026-07-15T12:00:00.000Z',
    todayTeamLocal: '2026-07-15',
    nowTeamLocal: '2026-07-15T14:00',
    utcOffsetMinutes: 120,
  },
  {
    label: 'UTC (identity)',
    zone: 'UTC',
    instant: '2026-01-15T12:00:00.000Z',
    todayTeamLocal: '2026-01-15',
    nowTeamLocal: '2026-01-15T12:00',
    utcOffsetMinutes: 0,
  },
  {
    label: 'America/New_York — negative offset: a UTC-naive implementation rolls the year forward',
    zone: 'America/New_York',
    instant: '2026-01-01T03:00:00.000Z',
    todayTeamLocal: '2025-12-31',
    nowTeamLocal: '2025-12-31T22:00',
    utcOffsetMinutes: -300,
  },
  {
    label: 'Asia/Kathmandu — non-whole-hour (+5:45): a +6:00 approximation rolls the day forward',
    zone: 'Asia/Kathmandu',
    instant: '2026-01-01T18:05:00.000Z',
    todayTeamLocal: '2026-01-01',
    nowTeamLocal: '2026-01-01T23:50',
    utcOffsetMinutes: 345,
  },
  {
    label: 'Pacific/Auckland — far-positive offset',
    zone: 'Pacific/Auckland',
    instant: '2026-01-01T12:00:00.000Z',
    todayTeamLocal: '2026-01-02',
    nowTeamLocal: '2026-01-02T01:00',
    utcOffsetMinutes: 780,
  },
];

describe('computeCurrentDatetime', () => {
  for (const tc of cases) {
    it.effect(tc.label, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(new Date(tc.instant).getTime());

        const result = yield* computeCurrentDatetime(tc.zone);

        expect(result.teamTimezone).toBe(tc.zone);
        expect(result.todayTeamLocal).toBe(tc.todayTeamLocal);
        expect(result.nowTeamLocal).toBe(tc.nowTeamLocal);
        expect(result.utcOffsetMinutes).toBe(tc.utcOffsetMinutes);

        // Discriminating assertion: `nowUtcIso` must round-trip to the exact
        // injected instant — not a value derived from (or equal to) the local
        // wall clock, which is the class of bug this table exists to catch.
        expect(new Date(result.nowUtcIso).getTime()).toBe(new Date(tc.instant).getTime());
      }),
    );
  }

  it.effect('nowTeamLocal is always exactly YYYY-MM-DDTHH:mm (no seconds, no offset suffix)', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date('2026-01-01T18:05:00.000Z').getTime());
      const result = yield* computeCurrentDatetime('Asia/Kathmandu');
      expect(result.nowTeamLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    }),
  );

  it.effect('todayTeamLocal is always exactly YYYY-MM-DD', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date('2026-01-01T18:05:00.000Z').getTime());
      const result = yield* computeCurrentDatetime('Asia/Kathmandu');
      expect(result.todayTeamLocal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }),
  );

  it.effect('an unknown/invalid IANA zone id does not throw — falls back rather than dying', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date('2026-01-15T12:00:00.000Z').getTime());
      const result = yield* computeCurrentDatetime('Not/AZone');
      // Per `applications/server/AGENTS.md` (`team_settings.timezone` is untrusted
      // free-form TEXT), an invalid zone must fall back to `Europe/Prague`, never
      // throw. This test only pins "does not throw / degrades to some valid zone
      // string" — the exact fallback zone is asserted implicitly by matching the
      // known-good Europe/Prague row's offset for the same instant.
      expect(result.utcOffsetMinutes).toBe(60);
      expect(result.todayTeamLocal).toBe('2026-01-15');
    }),
  );
});
