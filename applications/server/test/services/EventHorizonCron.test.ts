import { beforeEach, describe, expect, it } from '@effect/vitest';
import type {
  Discord,
  Event,
  EventSeries,
  GroupModel,
  Team,
  TeamMember,
  TrainingType,
} from '@sideline/domain';
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
const DISCORD_CHANNEL_ID = '111222333444555666' as Discord.Snowflake;
const GROUP_ID = 'group-abc-123' as GroupModel.GroupId;
const GROUP_DISCORD_CHANNEL_ID = '999000999000' as Discord.Snowflake;

// A date in the past that, when used as start_date, will produce occurrences
// within a 30-day horizon from "today". We use a fixed Monday.
// The series runs weekly on Monday (day index 1).
// We use DateTime.makeUnsafe with a very early date so the horizon window (today +30 days)
// will always contain at least one occurrence.
const START_DATE = DateTime.makeUnsafe('2020-01-06T00:00:00Z'); // a Monday

// --- Types for in-memory store ---
type InsertedEvent = {
  eventId: Event.EventId;
  teamId: Team.TeamId;
  title: string;
};

type EmittedCreated = {
  teamId: Team.TeamId;
  eventId: Event.EventId;
  discordTargetChannelId: Option.Option<Discord.Snowflake>;
};

type UpdatedDate = {
  seriesId: EventSeries.EventSeriesId;
};

// --- In-memory stores ---
let insertedEvents: InsertedEvent[];
let emittedCreated: EmittedCreated[];
let updatedDates: UpdatedDate[];

// Counter so each call gets a unique inserted event ID
let insertCounter: number;

// The emitEventCreated failure mode
let emitShouldFail: boolean;

// The group->channel mapping for the DiscordChannelMappingRepository mock
let groupChannelMapping: Option.Option<Discord.Snowflake>;

const resetStores = () => {
  insertedEvents = [];
  emittedCreated = [];
  updatedDates = [];
  insertCounter = 0;
  emitShouldFail = false;
  groupChannelMapping = Option.none();
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
    discord_target_channel_id: Option.Option<Discord.Snowflake>;
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
  discord_target_channel_id:
    overrides.discord_target_channel_id ?? Option.none<Discord.Snowflake>(),
  training_type_id: overrides.training_type_id ?? Option.none(),
  owner_group_id: overrides.owner_group_id ?? Option.none(),
  member_group_id: overrides.member_group_id ?? Option.none(),
  created_by: overrides.created_by ?? CREATED_BY,
  event_horizon_days: overrides.event_horizon_days ?? 30,
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

const makeMockEventsRepositoryLayer = (
  findEventByIdWithDetailsOverride?: (
    eventId: Event.EventId,
  ) => Effect.Effect<Option.Option<unknown>, never, never>,
) =>
  Layer.succeed(EventsRepository, {
    insertEvent: (params: { teamId: Team.TeamId; title: string }) => {
      insertCounter += 1;
      const eventId =
        `00000000-0000-0000-0000-0000000001${String(insertCounter).padStart(2, '0')}` as Event.EventId;
      insertedEvents.push({ eventId, teamId: params.teamId, title: params.title });
      return Effect.succeed({
        id: eventId,
        team_id: params.teamId,
        title: params.title,
        training_type_id: Option.none(),
        event_type: 'training',
        description: Option.none(),
        start_at: DateTime.makeUnsafe('2026-04-14T10:00:00Z'),
        end_at: Option.none(),
        location: Option.none(),
        status: 'active',
        created_by: CREATED_BY,
        series_id: Option.none(),
        series_modified: false,
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        member_group_id: Option.none(),
      });
    },
    findEventByIdWithDetails: (eventId: Event.EventId) => {
      if (findEventByIdWithDetailsOverride) {
        return findEventByIdWithDetailsOverride(eventId);
      }
      return Effect.succeed(
        Option.some({
          id: eventId,
          team_id: TEAM_ID,
          training_type_id: Option.none(),
          event_type: 'training',
          title: 'Weekly Training',
          description: Option.none(),
          start_at: DateTime.makeUnsafe('2026-04-14T10:00:00Z'),
          end_at: Option.none(),
          location: Option.none(),
          status: 'active',
          created_by: CREATED_BY,
          training_type_name: Option.none(),
          created_by_name: Option.none(),
          series_id: Option.none(),
          series_modified: false,
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          owner_group_name: Option.none(),
          member_group_id: Option.none(),
          member_group_name: Option.none(),
          reminder_sent_at: Option.none(),
        }),
      );
    },
    // Other stubs
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

const MockEventsRepositoryLayer = makeMockEventsRepositoryLayer();

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

const makeMockSyncEventsRepository = (
  overrides: Partial<{
    emitEventCreated: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      title: string,
      description: Option.Option<string>,
      startAt: DateTime.Utc,
      endAt: Option.Option<DateTime.Utc>,
      location: Option.Option<string>,
      eventEventType: string,
      discordTargetChannelId: Option.Option<Discord.Snowflake>,
    ) => Effect.Effect<void, never, never>;
  }> = {},
) =>
  Layer.succeed(EventSyncEventsRepository, {
    emitEventCreated: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _description: Option.Option<string>,
      _startAt: DateTime.Utc,
      _endAt: Option.Option<DateTime.Utc>,
      _location: Option.Option<string>,
      _eventEventType: string,
      discordTargetChannelId: Option.Option<Discord.Snowflake>,
    ) => {
      if (overrides.emitEventCreated) {
        return overrides.emitEventCreated(
          teamId,
          eventId,
          _title,
          _description,
          _startAt,
          _endAt,
          _location,
          _eventEventType,
          discordTargetChannelId,
        );
      }
      if (emitShouldFail) {
        return Effect.die(new Error('Discord sync failed'));
      }
      emittedCreated.push({ teamId, eventId, discordTargetChannelId });
      return Effect.void;
    },
    emitEventStarted: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: (_teamId: Team.TeamId, _groupId: GroupModel.GroupId) =>
    Effect.succeed(
      Option.map(groupChannelMapping, (channelId) => ({
        discord_channel_id: Option.some(channelId),
      })),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
  deleteByGroupId: () => Effect.die(new Error('Not implemented')),
  findByRosterId: () => Effect.die(new Error('Not implemented')),
  insertRoster: () => Effect.die(new Error('Not implemented')),
  deleteByRosterId: () => Effect.die(new Error('Not implemented')),
  findAllByTeam: () => Effect.die(new Error('Not implemented')),
} as any);

const makeTestLayer = (
  activeSeries: ReturnType<typeof makeActiveSeries>[],
  syncOverrides?: Parameters<typeof makeMockSyncEventsRepository>[0],
  findEventByIdWithDetailsOverride?: Parameters<typeof makeMockEventsRepositoryLayer>[0],
) =>
  Layer.mergeAll(
    makeMockEventSeriesRepository(activeSeries),
    findEventByIdWithDetailsOverride
      ? makeMockEventsRepositoryLayer(findEventByIdWithDetailsOverride)
      : MockEventsRepositoryLayer,
    MockTrainingTypesRepositoryLayer,
    MockTeamSettingsRepositoryLayer,
    MockDiscordChannelMappingRepositoryLayer,
    makeMockSyncEventsRepository(syncOverrides),
  );

beforeEach(() => {
  resetStores();
});

describe('eventHorizonCronEffect', () => {
  it.effect('generates events and emits sync events for each', () => {
    const series = makeActiveSeries({
      // Use yesterday as the last generated date so at least one occurrence falls in the window.
      // Actually, let's use no last_generated_date and a start_date far in the past to ensure
      // occurrences are generated within the 30-day horizon from today.
      last_generated_date: Option.none(),
      // Use a start_date just before the horizon window starts (a Monday from the recent past)
      // so occurrences land within the 30-day horizon.
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3, 4, 5], // Mon-Fri, so we get multiple occurrences
      event_horizon_days: 30,
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertedEvents.length).toBeGreaterThan(0);
          expect(emittedCreated.length).toBe(insertedEvents.length);
          // Each inserted event should have a corresponding emitted sync event
          for (const inserted of insertedEvents) {
            const emitted = emittedCreated.find((e) => e.eventId === inserted.eventId);
            expect(emitted).toBeDefined();
            expect(emitted?.teamId).toBe(TEAM_ID);
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
          expect(emittedCreated).toHaveLength(0);
          expect(updatedDates).toHaveLength(0);
        }),
      ),
      Effect.provide(makeTestLayer([])),
      Effect.asVoid,
    ),
  );

  it.effect('notification failure does not block event creation', () => {
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3, 4, 5],
      event_horizon_days: 30,
    });

    emitShouldFail = true;

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Events should still have been inserted despite emit failure
          expect(insertedEvents.length).toBeGreaterThan(0);
          // updateLastGeneratedDate should still have been called
          expect(updatedDates).toHaveLength(1);
          expect(updatedDates[0].seriesId).toBe(SERIES_ID);
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });

  it.effect('series with no guild still creates events', () => {
    // emitEventCreated internally no-ops when team has no guild — we model this by
    // returning Effect.void without recording anything (simulate the internal behavior)
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3],
      event_horizon_days: 30,
    });

    const noGuildSyncLayer = makeMockSyncEventsRepository({
      emitEventCreated: () => Effect.void, // guild check returns none, no-op
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Events were still created even though emit was a no-op
          expect(insertedEvents.length).toBeGreaterThan(0);
          // updateLastGeneratedDate should have been called
          expect(updatedDates).toHaveLength(1);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          makeMockEventSeriesRepository([series]),
          MockEventsRepositoryLayer,
          MockTrainingTypesRepositoryLayer,
          MockTeamSettingsRepositoryLayer,
          MockDiscordChannelMappingRepositoryLayer,
          noGuildSyncLayer,
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('passes resolved channel to emitEventCreated', () => {
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1], // Just Monday so we get a predictable number of events
      event_horizon_days: 7,
    });

    // Override TeamSettings to return a training channel ID — resolveChannel will pick it up
    const TeamSettingsWithChannelLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEAM_ID,
            event_horizon_days: 30,
            min_players_threshold: 0,
            rsvp_reminder_hours: 0,
            discord_channel_training: Option.some(DISCORD_CHANNEL_ID),
            discord_channel_match: Option.none(),
            discord_channel_tournament: Option.none(),
            discord_channel_meeting: Option.none(),
            discord_channel_social: Option.none(),
            discord_channel_other: Option.none(),
            discord_channel_late_rsvp: Option.none(),
            create_discord_channel_on_group: false,
            create_discord_channel_on_roster: false,
            discord_archive_category_id: Option.none(),
            discord_channel_cleanup_on_group_delete: 'delete',
            discord_channel_cleanup_on_roster_deactivate: 'delete',
            discord_role_format: '{name}',
            discord_channel_format: '{name}',
          }),
        ),
      upsert: () => Effect.die(new Error('Not implemented')),
      getHorizonDays: () => Effect.die(new Error('Not implemented')),
      findLateRsvpChannelId: () => Effect.die(new Error('Not implemented')),
      findEventsNeedingReminder: () => Effect.die(new Error('Not implemented')),
    } as any);

    const trackingEmittedLayer = Layer.succeed(EventSyncEventsRepository, {
      emitEventCreated: (
        teamId: Team.TeamId,
        eventId: Event.EventId,
        _title: string,
        _description: Option.Option<string>,
        _startAt: DateTime.Utc,
        _endAt: Option.Option<DateTime.Utc>,
        _location: Option.Option<string>,
        _eventEventType: string,
        discordTargetChannelId: Option.Option<Discord.Snowflake>,
      ) => {
        emittedCreated.push({ teamId, eventId, discordTargetChannelId });
        return Effect.void;
      },
      emitEventStarted: () => Effect.void,
      emitEventUpdated: () => Effect.void,
      emitEventCancelled: () => Effect.void,
      emitRsvpReminder: () => Effect.void,
      findUnprocessed: () => Effect.succeed([]),
      markProcessed: () => Effect.void,
      markFailed: () => Effect.void,
    } as any);

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCreated.length).toBeGreaterThan(0);
          // All emitted events should have the resolved channel ID
          for (const emitted of emittedCreated) {
            expect(Option.isSome(emitted.discordTargetChannelId)).toBe(true);
            if (Option.isSome(emitted.discordTargetChannelId)) {
              expect(emitted.discordTargetChannelId.value).toBe(DISCORD_CHANNEL_ID);
            }
          }
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          makeMockEventSeriesRepository([series]),
          MockEventsRepositoryLayer,
          MockTrainingTypesRepositoryLayer,
          TeamSettingsWithChannelLayer,
          MockDiscordChannelMappingRepositoryLayer,
          trackingEmittedLayer,
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('updates lastGeneratedDate after all events in a series', () => {
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1, 2, 3],
      event_horizon_days: 30,
    });

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(updatedDates).toHaveLength(1);
          expect(updatedDates[0].seriesId).toBe(SERIES_ID);
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });

  it.effect('resolves channel from owner group when no other channel configured', () => {
    // No per-event channel, no training type channel, no team settings channel,
    // but the owner group has a Discord channel mapping.
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1],
      event_horizon_days: 7,
      owner_group_id: Option.some(GROUP_ID),
      discord_target_channel_id: Option.none(),
    });

    // Arrange: the group->channel mapping returns GROUP_DISCORD_CHANNEL_ID
    groupChannelMapping = Option.some(GROUP_DISCORD_CHANNEL_ID);

    // Arrange: the event returned by findEventByIdWithDetails has owner_group_id set
    const findEventWithOwnerGroup = (eventId: Event.EventId) =>
      Effect.succeed(
        Option.some({
          id: eventId,
          team_id: TEAM_ID,
          training_type_id: Option.none(),
          event_type: 'training',
          title: 'Weekly Training',
          description: Option.none(),
          start_at: DateTime.makeUnsafe('2026-04-14T10:00:00Z'),
          end_at: Option.none(),
          location: Option.none(),
          status: 'active',
          created_by: CREATED_BY,
          training_type_name: Option.none(),
          created_by_name: Option.none(),
          series_id: Option.none(),
          series_modified: false,
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.some(GROUP_ID),
          owner_group_name: Option.none(),
          member_group_id: Option.none(),
          member_group_name: Option.none(),
          reminder_sent_at: Option.none(),
        }),
      );

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCreated.length).toBeGreaterThan(0);
          // All emitted events should use the owner group's channel
          for (const emitted of emittedCreated) {
            expect(Option.isSome(emitted.discordTargetChannelId)).toBe(true);
            if (Option.isSome(emitted.discordTargetChannelId)) {
              expect(emitted.discordTargetChannelId.value).toBe(GROUP_DISCORD_CHANNEL_ID);
            }
          }
        }),
      ),
      Effect.provide(makeTestLayer([series], undefined, findEventWithOwnerGroup)),
      Effect.asVoid,
    );
  });

  it.effect('team settings channel wins over owner group channel', () => {
    // Both team settings channel AND owner group channel are configured.
    // Team settings (fallback #3) should take priority over owner group (fallback #4).
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1],
      event_horizon_days: 7,
      owner_group_id: Option.some(GROUP_ID),
      discord_target_channel_id: Option.none(),
    });

    // Arrange: owner group mapping is set
    groupChannelMapping = Option.some(GROUP_DISCORD_CHANNEL_ID);

    // Arrange: team settings also has a channel configured
    const TeamSettingsWithChannelLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEAM_ID,
            event_horizon_days: 30,
            min_players_threshold: 0,
            rsvp_reminder_hours: 0,
            discord_channel_training: Option.some(DISCORD_CHANNEL_ID),
            discord_channel_match: Option.none(),
            discord_channel_tournament: Option.none(),
            discord_channel_meeting: Option.none(),
            discord_channel_social: Option.none(),
            discord_channel_other: Option.none(),
            discord_channel_late_rsvp: Option.none(),
            create_discord_channel_on_group: false,
            create_discord_channel_on_roster: false,
            discord_archive_category_id: Option.none(),
            discord_channel_cleanup_on_group_delete: 'delete',
            discord_channel_cleanup_on_roster_deactivate: 'delete',
            discord_role_format: '{name}',
            discord_channel_format: '{name}',
          }),
        ),
      upsert: () => Effect.die(new Error('Not implemented')),
      getHorizonDays: () => Effect.die(new Error('Not implemented')),
      findLateRsvpChannelId: () => Effect.die(new Error('Not implemented')),
      findEventsNeedingReminder: () => Effect.die(new Error('Not implemented')),
    } as any);

    // Arrange: the event returned by findEventByIdWithDetails has owner_group_id set
    const findEventWithOwnerGroup = (eventId: Event.EventId) =>
      Effect.succeed(
        Option.some({
          id: eventId,
          team_id: TEAM_ID,
          training_type_id: Option.none(),
          event_type: 'training',
          title: 'Weekly Training',
          description: Option.none(),
          start_at: DateTime.makeUnsafe('2026-04-14T10:00:00Z'),
          end_at: Option.none(),
          location: Option.none(),
          status: 'active',
          created_by: CREATED_BY,
          training_type_name: Option.none(),
          created_by_name: Option.none(),
          series_id: Option.none(),
          series_modified: false,
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.some(GROUP_ID),
          owner_group_name: Option.none(),
          member_group_id: Option.none(),
          member_group_name: Option.none(),
          reminder_sent_at: Option.none(),
        }),
      );

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCreated.length).toBeGreaterThan(0);
          // Team settings channel (DISCORD_CHANNEL_ID) should win over group channel
          for (const emitted of emittedCreated) {
            expect(Option.isSome(emitted.discordTargetChannelId)).toBe(true);
            if (Option.isSome(emitted.discordTargetChannelId)) {
              expect(emitted.discordTargetChannelId.value).toBe(DISCORD_CHANNEL_ID);
            }
          }
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          makeMockEventSeriesRepository([series]),
          makeMockEventsRepositoryLayer(findEventWithOwnerGroup),
          MockTrainingTypesRepositoryLayer,
          TeamSettingsWithChannelLayer,
          MockDiscordChannelMappingRepositoryLayer,
          makeMockSyncEventsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('no owner group returns Option.none for channel', () => {
    // No per-event channel, no training type channel, no team settings channel,
    // and owner_group_id is Option.none() — so channel should be Option.none().
    const series = makeActiveSeries({
      last_generated_date: Option.none(),
      start_date: DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }),
      days_of_week: [1],
      event_horizon_days: 7,
      owner_group_id: Option.none(),
      discord_target_channel_id: Option.none(),
    });

    // Arrange: no group mapping configured
    groupChannelMapping = Option.none();

    return eventHorizonCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCreated.length).toBeGreaterThan(0);
          // All emitted events should have no channel resolved
          for (const emitted of emittedCreated) {
            expect(Option.isNone(emitted.discordTargetChannelId)).toBe(true);
          }
        }),
      ),
      Effect.provide(makeTestLayer([series])),
      Effect.asVoid,
    );
  });
});
