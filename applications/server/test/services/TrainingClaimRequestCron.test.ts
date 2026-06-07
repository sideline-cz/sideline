// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They test TrainingClaimRequestCron (new cron service) behavior:
//   - When there is a pending event with a resolvable owner channel:
//     emitTrainingClaimRequest is called once, markClaimRequestSent is called.
//   - Re-running the cron tick (when findEventsNeedingClaimRequest returns empty)
//     does NOT re-emit.
//   - When there is no owner channel: warns + marks sent (no infinite rescan), no emit.
//
// ASSUMPTION: trainingClaimRequestCronEffect is exported from
//   ~/services/TrainingClaimRequestCron.ts (a new file).
// ASSUMPTION: EventsRepository.markClaimRequestSent(eventId) is a new method.
// ASSUMPTION: TeamSettingsRepository.findEventsNeedingClaimRequest() returns events
//   whose lead-time day has been reached and claim_request_sent_at IS NULL.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { trainingClaimRequestCronEffect } from '~/services/TrainingClaimRequestCron.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000020' as Team.TeamId;
const EVENT_ID_1 = '00000000-0000-0000-0000-000000000101' as Event.EventId;
const GROUP_ID_A = '00000000-0000-0000-0000-000000000040' as GroupModel.GroupId;
const OWNER_CHANNEL = '333333333333333333' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type ClaimEvent = {
  event_id: Event.EventId;
  team_id: Team.TeamId;
  title: string;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  description: Option.Option<string>;
  event_type: string;
  owner_group_id: Option.Option<GroupModel.GroupId>;
};

let pendingEvents: ClaimEvent[];
let markedSent: Event.EventId[];
let emittedEvents: Array<{ teamId: Team.TeamId; eventId: Event.EventId }>;
let channelMappings: Map<
  string,
  {
    discord_channel_id: Option.Option<Discord.Snowflake>;
    discord_role_id: Option.Option<Discord.Snowflake>;
  }
>;

const resetStores = () => {
  pendingEvents = [];
  markedSent = [];
  emittedEvents = [];
  channelMappings = new Map();
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamSettings = () =>
  Layer.succeed(TeamSettingsRepository, {
    findEventsNeedingClaimRequest: () => Effect.succeed(pendingEvents),
    findEventsNeedingClaimRequestAt: () => Effect.succeed(pendingEvents),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
    findEventsNeedingReminder: () => Effect.succeed([]),
    findEventsNeedingReminderAt: () => Effect.succeed([]),
  } as any);

const makeMockEventsRepo = () =>
  Layer.succeed(EventsRepository, {
    markClaimRequestSent: (id: Event.EventId) => {
      markedSent.push(id);
      return Effect.void;
    },
    markReminderSent: () => Effect.void,
    findEventsToStart: () => Effect.succeed([]),
    findEventsByTeamId: () => Effect.die(new Error('Not implemented')),
    findEventByIdWithDetails: () => Effect.die(new Error('Not implemented')),
    insertEvent: () => Effect.die(new Error('Not implemented')),
    updateEvent: () => Effect.die(new Error('Not implemented')),
    cancelEvent: () => Effect.die(new Error('Not implemented')),
    getScopedTrainingTypeIds: () => Effect.die(new Error('Not implemented')),
    saveDiscordMessageId: () => Effect.die(new Error('Not implemented')),
    getDiscordMessageId: () => Effect.die(new Error('Not implemented')),
    findEventsByChannelId: () => Effect.die(new Error('Not implemented')),
    markEventSeriesModified: () => Effect.die(new Error('Not implemented')),
    cancelFutureInSeries: () => Effect.die(new Error('Not implemented')),
    updateFutureUnmodifiedInSeries: () => Effect.die(new Error('Not implemented')),
    findUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
    countUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
    findEventsByUserId: () => Effect.die(new Error('Not implemented')),
    findEndedTrainingsForAutoLog: () => Effect.die(new Error('Not implemented')),
    markTrainingAutoLogged: () => Effect.die(new Error('Not implemented')),
    findUpcomingWithRsvp: () => Effect.die(new Error('Not implemented')),
    startEvent: () => Effect.die(new Error('Not implemented')),
    claimTraining: () => Effect.die(new Error('Not implemented')),
    unclaimTraining: () => Effect.die(new Error('Not implemented')),
    saveClaimDiscordMessage: () => Effect.die(new Error('Not implemented')),
    findClaimInfo: () => Effect.die(new Error('Not implemented')),
  } as any);

const makeMockSyncEvents = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitTrainingClaimRequest: (teamId: Team.TeamId, eventId: Event.EventId) => {
      emittedEvents.push({ teamId, eventId });
      return Effect.void;
    },
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitEventStarted: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitTrainingClaimUpdate: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeMockChannelMapping = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: (teamId: Team.TeamId, groupId: GroupModel.GroupId) => {
      const key = `${teamId}:${groupId}`;
      const mapping = channelMappings.get(key);
      return Effect.succeed(mapping ? Option.some(mapping) : Option.none());
    },
    insert: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    findAllByTeamId: () => Effect.succeed([]),
    findAllByTeam: () => Effect.succeed([]),
  } as any);

const buildLayer = () =>
  Layer.mergeAll(
    makeMockTeamSettings(),
    makeMockEventsRepo(),
    makeMockSyncEvents(),
    makeMockChannelMapping(),
  );

const makeEvent = (overrides: Partial<ClaimEvent> = {}): ClaimEvent => ({
  event_id: EVENT_ID_1,
  team_id: TEAM_ID,
  title: 'Weekly Training',
  start_at: DateTime.makeUnsafe('2026-06-10T10:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  description: Option.none(),
  event_type: 'training',
  owner_group_id: Option.some(GROUP_ID_A),
  ...overrides,
});

beforeEach(() => resetStores());
afterEach(() => resetStores());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrainingClaimRequestCron — trainingClaimRequestCronEffect', () => {
  it.effect(
    'one pending event with resolvable owner channel → emitTrainingClaimRequest + markClaimRequestSent once',
    () => {
      pendingEvents = [makeEvent()];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: Option.some(OWNER_CHANNEL),
        discord_role_id: Option.none(),
      });

      return trainingClaimRequestCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].eventId).toBe(EVENT_ID_1);
            expect(markedSent).toHaveLength(1);
            expect(markedSent[0]).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(buildLayer()),
        Effect.asVoid,
      );
    },
  );

  it.effect('re-run tick (second call with empty pending) → not re-emitted', () => {
    pendingEvents = [makeEvent()];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(OWNER_CHANNEL),
      discord_role_id: Option.none(),
    });

    const layer = buildLayer();

    return Effect.Do.pipe(
      // First tick — emits and marks
      Effect.tap(() => trainingClaimRequestCronEffect.pipe(Effect.provide(layer))),
      Effect.tap(() =>
        Effect.sync(() => {
          // Simulate DB marking: second tick returns empty
          pendingEvents = [];
        }),
      ),
      // Second tick — nothing pending
      Effect.tap(() => trainingClaimRequestCronEffect.pipe(Effect.provide(layer))),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedEvents).toHaveLength(1);
          expect(markedSent).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
    ) as Effect.Effect<void, never, never>;
  });

  it.effect('no owner channel → warns + marks sent (no infinite rescan), no emit', () => {
    pendingEvents = [makeEvent()];
    // No channel mapping registered → no channel to emit to

    return trainingClaimRequestCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedEvents).toHaveLength(0);
          // Must still mark sent to prevent infinite rescan
          expect(markedSent).toHaveLength(1);
          expect(markedSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });

  it.effect('owner_group_id is None → warns + marks sent (no infinite rescan), no emit', () => {
    pendingEvents = [makeEvent({ owner_group_id: Option.none() })];

    return trainingClaimRequestCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedEvents).toHaveLength(0);
          // Must mark sent to prevent infinite rescan on every tick
          expect(markedSent).toHaveLength(1);
          expect(markedSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });

  it.effect('empty pending list → does nothing', () => {
    pendingEvents = [];

    return trainingClaimRequestCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedEvents).toHaveLength(0);
          expect(markedSent).toHaveLength(0);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });
});
