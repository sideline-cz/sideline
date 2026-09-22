import { beforeEach, describe, expect, it } from '@effect/vitest';
import type { Event, EventSeries, Team, TeamMember, TrainingType } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { eventHorizonCronEffect } from '~/services/EventHorizonCron.js';

// --- Test IDs ---
const SERIES_ID = '10000000-0000-0000-0000-000000000001' as EventSeries.EventSeriesId;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const CREATED_BY = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

// A date in the past that, when used as start_date, will produce occurrences
// within a 30-day horizon from "today". We use a fixed Monday.
const START_DATE = DateTime.makeUnsafe('2020-01-06T00:00:00Z'); // a Monday

// --- Types for in-memory store ---
type InsertedEvent = {
  eventId: Event.EventId;
  teamId: Team.TeamId;
  title: string;
  startAt: DateTime.Utc;
};

type UpdatedDate = {
  seriesId: EventSeries.EventSeriesId;
};

// --- In-memory stores ---
let insertedEvents: InsertedEvent[];
let updatedDates: UpdatedDate[];

// Counter so each call gets a unique inserted event ID
let insertCounter: number;

const resetStores = () => {
  insertedEvents = [];
  updatedDates = [];
  insertCounter = 0;
};

// --- Helpers to build a minimal EventSeriesForGeneration-shaped object ---
const makeActiveSeries = (
  overrides: Partial<{
    id: EventSeries.EventSeriesId;
    team_id: Team.TeamId;
    title: string;
    start_date: DateTime.Utc;
    last_generated_date: Option.Option<DateTime.Utc>;
    end_date: Option.Option<DateTime.Utc>;
    owner_group_id: Option.Option<unknown>;
    member_group_id: Option.Option<unknown>;
    event_horizon_days: number;
    days_of_week: ReadonlyArray<number>;
    frequency: 'weekly' | 'biweekly';
    start_time: string;
    end_time: Option.Option<string>;
    training_type_id: Option.Option<TrainingType.TrainingTypeId>;
    location: Option.Option<string>;
    location_url: Option.Option<string>;
    description: Option.Option<string>;
    created_by: TeamMember.TeamMemberId;
    team_timezone: string;
    // Release N (`.work-plans/series-time-conversion.md` §N.2): defaults `true`
    // so every PRE-EXISTING test in this file (written when `EventHorizonCron` called
    // `resolveOccurrenceInstant` unconditionally, i.e. always team-local) keeps its
    // original meaning unchanged. Only the new `false`-row case below overrides this.
    times_are_team_local: boolean;
  }> = {},
) => ({
  id: overrides.id ?? SERIES_ID,
  team_id: overrides.team_id ?? TEAM_ID,
  title: overrides.title ?? 'Weekly Training',
  description: overrides.description ?? Option.none<string>(),
  start_time: overrides.start_time ?? '10:00:00',
  end_time: overrides.end_time ?? Option.none<string>(),
  location: overrides.location ?? Option.none<string>(),
  location_url: overrides.location_url ?? Option.none<string>(),
  frequency: overrides.frequency ?? ('weekly' as const),
  days_of_week: overrides.days_of_week ?? [1], // Monday
  start_date: overrides.start_date ?? START_DATE,
  end_date: overrides.end_date ?? Option.none<DateTime.Utc>(),
  last_generated_date: overrides.last_generated_date ?? Option.none<DateTime.Utc>(),
  training_type_id: overrides.training_type_id ?? Option.none(),
  owner_group_id: overrides.owner_group_id ?? Option.none(),
  times_are_team_local: overrides.times_are_team_local ?? true,
  member_group_id: overrides.member_group_id ?? Option.none(),
  created_by: overrides.created_by ?? CREATED_BY,
  event_horizon_days: overrides.event_horizon_days ?? 30,
  team_timezone: overrides.team_timezone ?? 'Europe/Prague',
});

// --- Mock layers ---

const makeMockEventSeriesRepository = (activeSeries: ReturnType<typeof makeActiveSeries>[]) =>
  Layer.succeed(EventSeriesRepository, {
    getActiveForGeneration: () => Effect.succeed(activeSeries),
    updateLastGeneratedDate: (seriesId: EventSeries.EventSeriesId) => {
      updatedDates.push({ seriesId });
      return Effect.void;
    },
    // Stubs for unused methods
    insertEventSeries: () => Effect.die(new Error('Not implemented')),
    findSeriesByTeamId: () => Effect.die(new Error('Not implemented')),
    findSeriesById: () => Effect.die(new Error('Not implemented')),
    updateEventSeries: () => Effect.die(new Error('Not implemented')),
    cancelEventSeries: () => Effect.die(new Error('Not implemented')),
  } as any);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  insertEvent: (params: { teamId: Team.TeamId; title: string; startAt: DateTime.Utc }) => {
    insertCounter += 1;
    const eventId =
      `00000000-0000-0000-0000-0000000001${String(insertCounter).padStart(2, '0')}` as Event.EventId;
    // Capture the ACTUAL `startAt` the cron computed (via
    // `resolveOccurrenceInstant`), not a hardcoded stand-in — this is what
    // lets the DST regression tests below assert on the real materialized
    // instant instead of a fixture value that ignores the series' timezone.
    insertedEvents.push({
      eventId,
      teamId: params.teamId,
      title: params.title,
      startAt: params.startAt,
    });
    return Effect.succeed({
      id: eventId,
      team_id: params.teamId,
      title: params.title,
      training_type_id: Option.none(),
      event_type: 'training',
      description: Option.none(),
      start_at: params.startAt,
      end_at: Option.none(),
      location: Option.none(),
      location_url: Option.none(),
      status: 'active',
      created_by: CREATED_BY,
      series_id: Option.none(),
      series_modified: false,
      owner_group_id: Option.none(),
      member_group_id: Option.none(),
    });
  },
  markEventPersonalMessagesDirty: () => Effect.void,
  markClaimRequestSent: () => Effect.void,
  // Other stubs
  findEventByIdWithDetails: () => Effect.die(new Error('Not implemented')),
  findEventsByTeamId: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancelEvent: () => Effect.die(new Error('Not implemented')),
  startEvent: () => Effect.die(new Error('Not implemented')),
  findEventsToStart: () => Effect.die(new Error('Not implemented')),
  getScopedTrainingTypeIds: () => Effect.die(new Error('Not implemented')),
  saveDiscordMessageId: () => Effect.die(new Error('Not implemented')),
  getDiscordMessageId: () => Effect.die(new Error('Not implemented')),
  findEventsByChannelId: () => Effect.die(new Error('Not implemented')),
  markReminderSent: () => Effect.die(new Error('Not implemented')),
  markEventSeriesModified: () => Effect.die(new Error('Not implemented')),
  cancelFutureInSeries: () => Effect.die(new Error('Not implemented')),
  updateFutureUnmodifiedInSeries: () => Effect.die(new Error('Not implemented')),
  findUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
  countUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
  findEventsByUserId: () => Effect.die(new Error('Not implemented')),
  findEndedTrainingsForAutoLog: () => Effect.die(new Error('Not implemented')),
  markTrainingAutoLogged: () => Effect.die(new Error('Not implemented')),
  findUpcomingWithRsvp: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  findTrainingTypeById: () => Effect.succeed(Option.none()),
  findTrainingTypesByTeamId: () => Effect.die(new Error('Not implemented')),
  findTrainingTypeByIdWithGroup: () => Effect.die(new Error('Not implemented')),
  insertTrainingType: () => Effect.die(new Error('Not implemented')),
  updateTrainingType: () => Effect.die(new Error('Not implemented')),
  deleteTrainingTypeById: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizonDays: () => Effect.die(new Error('Not implemented')),
  findLateRsvpChannelId: () => Effect.die(new Error('Not implemented')),
  findEventsNeedingReminder: () => Effect.die(new Error('Not implemented')),
} as any);

// owner_group_id is Option.none() on the default fixture, so
// emitTrainingClaimRequestIfApplicable short-circuits without touching these —
// this layer only exists to satisfy the requirement.
const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitTrainingClaimRequest: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  deleteByGroupId: () => Effect.die(new Error('Not implemented')),
  findByRosterId: () => Effect.die(new Error('Not implemented')),
  insertRoster: () => Effect.die(new Error('Not implemented')),
  deleteByRosterId: () => Effect.die(new Error('Not implemented')),
  findAllByTeam: () => Effect.die(new Error('Not implemented')),
} as any);

const makeTestLayer = (activeSeries: ReturnType<typeof makeActiveSeries>[]) =>
  Layer.mergeAll(
    makeMockEventSeriesRepository(activeSeries),
    MockEventsRepositoryLayer,
    MockTrainingTypesRepositoryLayer,
    MockTeamSettingsRepositoryLayer,
    MockDiscordChannelMappingRepositoryLayer,
    MockEventSyncEventsRepositoryLayer,
  );

beforeEach(() => {
  resetStores();
});

describe('eventHorizonCronEffect', () => {
  it.effect('generates events for active series within the horizon window', () => {
    const series = makeActiveSeries({
      // Use no last_generated_date and a start_date just before the horizon window starts
      // so occurrences land within the 30-day horizon from "today".
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3, 4, 5], // Mon-Fri, so we get multiple occurrences
      event_horizon_days: 30,
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertedEvents.length).toBeGreaterThan(0);
          for (const inserted of insertedEvents) {
            expect(inserted.teamId).toBe(TEAM_ID);
          }
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });

  it.effect('does nothing when no active series exist', () =>
    eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertedEvents).toHaveLength(0);
          expect(updatedDates).toHaveLength(0);
        }),
      ),
      Effect.provide(makeTestLayer([])),
      Effect.asVoid,
    ),
  );

  it.effect('updates lastGeneratedDate after all events in a series are generated', () => {
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3],
      event_horizon_days: 30,
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertedEvents.length).toBeGreaterThan(0);
          expect(updatedDates).toHaveLength(1);
          expect(updatedDates[0].seriesId).toBe(SERIES_ID);
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });

  it.effect('produces no events when the series window has already fully elapsed', () => {
    const series = makeActiveSeries({
      last_generated_date: Option.some(DateTime.nowUnsafe()),
      start_date: START_DATE,
      end_date: Option.some(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 })),
      days_of_week: [1],
      event_horizon_days: 30,
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertedEvents).toHaveLength(0);
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });

  // --- DST regression (end-to-end materialization path) ---
  //
  // Both series below are pinned to generate EXACTLY ONE occurrence, on a
  // fixed calendar date, by setting `last_generated_date` to the day before
  // the target Tuesday and `end_date` to the target Tuesday itself — this
  // isolates the single materialized `startAt` instead of the open-ended
  // "many Tuesdays between start_date and now+horizon" window the other
  // tests above use. 2026-01-13 and 2026-07-14 are both Tuesdays.
  it.effect(
    'Prague series at 18:00, WINTER occurrence: materializes at 2026-01-13T17:00:00Z (CET, UTC+1)',
    () => {
      const series = makeActiveSeries({
        start_time: '18:00:00',
        team_timezone: 'Europe/Prague',
        days_of_week: [2], // Tuesday
        last_generated_date: Option.some(DateTime.makeUnsafe('2026-01-12T00:00:00Z')),
        end_date: Option.some(DateTime.makeUnsafe('2026-01-13T00:00:00Z')),
        event_horizon_days: 30,
      });

      return eventHorizonCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(insertedEvents).toHaveLength(1);
            expect(insertedEvents[0].startAt.epochMilliseconds).toBe(
              Date.parse('2026-01-13T17:00:00.000Z'),
            );
          }),
        ),
        Effect.provide(makeTestLayer([series])),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'THE SAME Prague series at 18:00, SUMMER occurrence: materializes at 2026-07-14T16:00:00Z (CEST, UTC+2) — one hour earlier in UTC than the winter case, same wall clock',
    () => {
      const series = makeActiveSeries({
        start_time: '18:00:00',
        team_timezone: 'Europe/Prague',
        days_of_week: [2], // Tuesday
        last_generated_date: Option.some(DateTime.makeUnsafe('2026-07-13T00:00:00Z')),
        end_date: Option.some(DateTime.makeUnsafe('2026-07-14T00:00:00Z')),
        event_horizon_days: 30,
      });

      return eventHorizonCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(insertedEvents).toHaveLength(1);
            expect(insertedEvents[0].startAt.epochMilliseconds).toBe(
              Date.parse('2026-07-14T16:00:00.000Z'),
            );
            // Non-vacuity: the pre-fix naive `${date}T18:00:00Z` materialization
            // would have produced 18:00:00Z here (and in the winter test above),
            // making the two cases indistinguishable from a bug that always
            // stamps the UTC time-of-day literally. Assert they differ.
            expect(insertedEvents[0].startAt.epochMilliseconds).not.toBe(
              Date.parse('2026-07-14T18:00:00.000Z'),
            );
          }),
        ),
        Effect.provide(makeTestLayer([series])),
        Effect.asVoid,
      );
    },
  );

  // --- Release N regression (`.work-plans/series-time-conversion.md` §N.2/§N.c) ---
  //
  // A `times_are_team_local = false` series is Release N's "every row is FALSE, every branch
  // takes the UTC path, no data is rewritten" invariant in action: its `start_time` is a UTC
  // time-of-day (the pre-#650 semantics), not a team-local wall clock, so it must materialize
  // at the literal `${dateStr}T${time}Z` instant regardless of `team_timezone` — exactly the
  // SAME Prague/summer fixture as the TRUE case immediately above, so the only variable is the
  // flag. This is expected to FAIL until `EventHorizonCron.ts` reads `s.times_are_team_local`
  // and dispatches through `seriesTimeDialect.resolveSeriesOccurrenceInstant` instead of calling
  // `resolveOccurrenceInstant` unconditionally.
  it.effect(
    'Release N: a FALSE (UTC-dialect) Prague series at 18:00 materializes at 2026-07-14T18:00:00Z — NOT 16:00Z — because a FALSE row is never team-local, DST or no DST',
    () => {
      const series = makeActiveSeries({
        start_time: '18:00:00',
        team_timezone: 'Europe/Prague',
        times_are_team_local: false,
        days_of_week: [2], // Tuesday
        last_generated_date: Option.some(DateTime.makeUnsafe('2026-07-13T00:00:00Z')),
        end_date: Option.some(DateTime.makeUnsafe('2026-07-14T00:00:00Z')),
        event_horizon_days: 30,
      });

      return eventHorizonCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(insertedEvents).toHaveLength(1);
            expect(insertedEvents[0].startAt.epochMilliseconds).toBe(
              Date.parse('2026-07-14T18:00:00.000Z'),
            );
            // Non-vacuity: the TRUE case (same wall clock, same date, same zone,
            // immediately above) resolves to 16:00Z. If a regression made the cron
            // ignore the flag and always take the team-local branch, this FALSE-row
            // fixture would silently produce the SAME instant as the TRUE one.
            expect(insertedEvents[0].startAt.epochMilliseconds).not.toBe(
              Date.parse('2026-07-14T16:00:00.000Z'),
            );
          }),
        ),
        Effect.provide(makeTestLayer([series])),
        Effect.asVoid,
      );
    },
  );

  // Fix 4 (review): the FALSE-dialect regression above only covered the SUMMER half of the
  // winter/summer DST pair the TRUE case gets both halves of — leaving the entire "a FALSE row
  // is identical to v0.49.3" claim resting on one test in this file. This is the WINTER
  // counterpart, same fixture shape as the winter TRUE test above, `times_are_team_local: false`.
  it.effect(
    'Release N: a FALSE (UTC-dialect) Prague series at 18:00, WINTER occurrence: materializes at 2026-01-13T18:00:00Z — NOT 17:00Z — because a FALSE row is never team-local, DST or no DST',
    () => {
      const series = makeActiveSeries({
        start_time: '18:00:00',
        team_timezone: 'Europe/Prague',
        times_are_team_local: false,
        days_of_week: [2], // Tuesday
        last_generated_date: Option.some(DateTime.makeUnsafe('2026-01-12T00:00:00Z')),
        end_date: Option.some(DateTime.makeUnsafe('2026-01-13T00:00:00Z')),
        event_horizon_days: 30,
      });

      return eventHorizonCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(insertedEvents).toHaveLength(1);
            expect(insertedEvents[0].startAt.epochMilliseconds).toBe(
              Date.parse('2026-01-13T18:00:00.000Z'),
            );
            // Non-vacuity: the TRUE winter case above resolves to 17:00Z. If a regression
            // made the cron ignore the flag and always take the team-local branch, this
            // FALSE-row fixture would silently produce the SAME instant as the TRUE one.
            expect(insertedEvents[0].startAt.epochMilliseconds).not.toBe(
              Date.parse('2026-01-13T17:00:00.000Z'),
            );
          }),
        ),
        Effect.provide(makeTestLayer([series])),
        Effect.asVoid,
      );
    },
  );
});
