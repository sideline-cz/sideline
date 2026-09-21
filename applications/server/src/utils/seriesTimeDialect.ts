import { EventSeriesApi } from '@sideline/domain';
import { DateTime, Effect } from 'effect';
import { resolveOccurrenceInstant } from '~/utils/seriesOccurrence.js';

/**
 * Resolves one series occurrence's `time` on calendar date `dateStr` to the instant it
 * denotes — dispatching on `timesAreTeamLocal`, the per-row storage dialect
 * (`event_series.times_are_team_local`), rather than assuming every row means the same
 * thing.
 *
 * `true` — the corrected, post-#650 semantics: `time` is a wall clock in `timezone`,
 * resolved via `resolveOccurrenceInstant`.
 *
 * `false` — the pre-#650, legacy semantics: `time` is a UTC time-of-day, resolved with the
 * literal `` `${dateStr}T${time}Z` `` expression, BYTE FOR BYTE identical to what
 * `EventHorizonCron.ts` did before #650 (`caab6e7e`). `timezone` is not consulted at all in
 * this branch — a `FALSE` row's `time` means the same instant regardless of which team it
 * belongs to. `time` is passed through UNNORMALISED: `resolveOccurrenceInstant`'s `HH:MM` ->
 * `HH:MM:00` zero-padding is new behaviour introduced for the team-local resolver, and must
 * not leak into this legacy branch — `DateTime.makeUnsafe` accepts `HH:MM:SSZ` and `HH:MMZ`
 * equally, so no normalisation is needed here in the first place.
 *
 * Release N ships no migration that converts rows to `TRUE` (see
 * `1791700000_add_series_times_team_local_flag.ts`), so in practice almost every row reaching
 * this function today takes the `FALSE` branch. The `TRUE` branch is nonetheless already
 * correct — both for a create that explicitly declares `timesAreTeamLocal: true`, and,
 * unchanged, once `1792100000` starts converting rows at Release N+1.
 */
export const resolveSeriesOccurrenceInstant = (
  dateStr: string,
  time: string,
  timezone: string,
  timesAreTeamLocal: boolean,
): DateTime.Utc =>
  timesAreTeamLocal
    ? resolveOccurrenceInstant(dateStr, time, timezone)
    : DateTime.makeUnsafe(`${dateStr}T${time}Z`);

/**
 * The timezone parameter to pass to a SQL re-derivation of a series' materialized
 * occurrences (`EventsRepository.updateFutureUnmodifiedInSeries`, and analogous re-anchor
 * statements): the team's own zone when the series is team-local (`TRUE`), or the literal
 * string `'UTC'` when it is not — a `FALSE` series' `start_time`/`end_time` are an absolute
 * UTC time-of-day, so the SQL that re-derives `start_at`/`end_at` from them must resolve in
 * UTC, never the team zone, or it would silently reinterpret a UTC time-of-day as if it were
 * wall clock.
 */
export const seriesSqlZone = (timezone: string, timesAreTeamLocal: boolean): string =>
  timesAreTeamLocal ? timezone : 'UTC';

/**
 * Asserts that a payload's declared time dialect matches the dialect already stored for the
 * row it would write to, failing with `EventSeriesApi.EventSeriesTimeDialectMismatch`
 * (HTTP 400) on any mismatch rather than translating between dialects — see that error
 * class's doc comment for why a silent conversion is not attempted.
 *
 * UPDATE-ONLY: a create has no existing row to assert against, so `event-series.ts`'s create
 * handler does not call this — it writes `payload.timesAreTeamLocal` straight through as the
 * new row's dialect instead. `EventSeriesTimeDialectMismatch` is registered on
 * `updateEventSeries`'s HTTP error union only.
 *
 * THIS APPLIES TO PAYLOAD-SUPPLIED TIMES ONLY. Callers must only invoke this when the
 * payload actually supplies `startTime` and/or `endTime` — on `UpdateEventSeriesRequest`
 * that means gating on `Option.isSome(payload.startTime) || Option.exists(payload.endTime,
 * Option.isSome)`, checked BEFORE resolving either field with `Option.getOrElse(...,
 * () => existing.*)`. `payload.endTime` is `Option<Option<string>>` — present-but-clearing
 * (`Some(None)`, from an explicit `endTime: null`) is NOT the same as "the payload supplied a
 * time"; `Option.isSome` alone would wrongly trip the gate for a clear that asserts no
 * time-of-day at all, hence `Option.exists(..., Option.isSome)` rather than `Option.isSome`
 * on the outer `Option`. A PATCH that omits both time fields is not asserting any dialect for
 * a value it never sent — a location-only edit from any client must pass through untouched,
 * regardless of what `timesAreTeamLocal` happens to encode on that request (see
 * `EventSeriesApi.ts`'s note that an "empty" patch still always encodes
 * `timesAreTeamLocal: false` on the wire, since the field is not `Option`-wrapped).
 */
export const assertDialectMatches = (
  payloadIsTeamLocal: boolean,
  storageIsTeamLocal: boolean,
): Effect.Effect<void, EventSeriesApi.EventSeriesTimeDialectMismatch> =>
  payloadIsTeamLocal === storageIsTeamLocal
    ? Effect.void
    : Effect.fail(new EventSeriesApi.EventSeriesTimeDialectMismatch());
