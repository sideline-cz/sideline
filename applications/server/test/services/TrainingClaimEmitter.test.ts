// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They test the lead-time gating behavior expected for the NEW cron path:
// TrainingClaimRequestCron calls emitTrainingClaimRequestIfApplicable (or a wrapper)
// for events returned by TeamSettingsRepository.findEventsNeedingClaimRequest().
//
// The EXISTING emitTrainingClaimRequestIfApplicable in TrainingClaimEmitter.ts is called
// at event creation time. The cron variant must:
//   - Call emitTrainingClaimRequest on EventSyncEventsRepository
//   - Call markClaimRequestSent on EventsRepository after successful emit
//   - Be a no-op for non-training events
//   - Be a no-op when owner_group_id is None or has no channel mapping
//
// ASSUMPTION: There is a new exported function (or the existing one is reused by the cron).
//   The cron tests below import from TrainingClaimEmitter.ts.
//   If the cron lives elsewhere, the import path must be adjusted.
//
// ASSUMPTION: EventsRepository has a new method markClaimRequestSent(eventId).
//   It does: UPDATE events SET claim_request_sent_at = now() WHERE id = $eventId.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
// ASSUMPTION: trainingClaimRequestCronEffect is exported from this module.
// If the developer names it differently, adjust here.
import { trainingClaimRequestCronEffect } from '~/services/TrainingClaimRequestCron.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const EVENT_ID_1 = '00000000-0000-0000-0000-000000000001' as Event.EventId;
const GROUP_ID_A = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const OWNER_CHANNEL = '111111111111111111' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type ClaimRequestEvent = {
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

let eventsNeedingClaimRequest: ClaimRequestEvent[];
let markedClaimRequestSent: Event.EventId[];
let emittedClaimRequests: Array<{
  teamId: Team.TeamId;
  eventId: Event.EventId;
  channelId: Discord.Snowflake;
}>;
let channelMappings: Map<
  string,
  {
    discord_channel_id: Option.Option<Discord.Snowflake>;
    discord_role_id: Option.Option<Discord.Snowflake>;
  }
>;

const resetStores = () => {
  eventsNeedingClaimRequest = [];
  markedClaimRequestSent = [];
  emittedClaimRequests = [];
  channelMappings = new Map();
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamSettingsRepository = () =>
  Layer.succeed(TeamSettingsRepository, {
    // ASSUMPTION: findEventsNeedingClaimRequest() calls findEventsNeedingClaimRequestAt(new Date())
    findEventsNeedingClaimRequest: () => Effect.succeed(eventsNeedingClaimRequest),
    findEventsNeedingClaimRequestAt: (_now: Date) => Effect.succeed(eventsNeedingClaimRequest),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
    findEventsNeedingReminder: () => Effect.succeed([]),
    findEventsNeedingReminderAt: () => Effect.succeed([]),
  } as any);

const makeMockEventsRepository = () =>
  Layer.succeed(EventsRepository, {
    // ASSUMPTION: new method markClaimRequestSent on EventsRepository
    markClaimRequestSent: (id: Event.EventId) => {
      markedClaimRequestSent.push(id);
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

const makeMockSyncEventsRepository = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitTrainingClaimRequest: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _startAt: unknown,
      _endAt: unknown,
      _location: unknown,
      _description: unknown,
      channelId: Discord.Snowflake,
    ) => {
      emittedClaimRequests.push({ teamId, eventId, channelId });
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

const makeMockChannelMappingRepository = () =>
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

const buildMockLayer = () =>
  Layer.mergeAll(
    makeMockTeamSettingsRepository(),
    makeMockEventsRepository(),
    makeMockSyncEventsRepository(),
    makeMockChannelMappingRepository(),
  );

const makeClaimEvent = (
  id: Event.EventId,
  overrides: Partial<ClaimRequestEvent> = {},
): ClaimRequestEvent => ({
  event_id: id,
  team_id: TEAM_ID,
  title: 'Monday Training',
  start_at: DateTime.makeUnsafe('2026-06-01T10:00:00Z'),
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

describe('TrainingClaimEmitter — trainingClaimRequestCronEffect lead-time gating', () => {
  it.effect(
    'training with owner channel → emitTrainingClaimRequest called AND markClaimRequestSent called',
    () => {
      eventsNeedingClaimRequest = [makeClaimEvent(EVENT_ID_1)];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: Option.some(OWNER_CHANNEL),
        discord_role_id: Option.none(),
      });

      return trainingClaimRequestCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedClaimRequests).toHaveLength(1);
            expect(emittedClaimRequests[0].eventId).toBe(EVENT_ID_1);
            expect(emittedClaimRequests[0].channelId).toBe(OWNER_CHANNEL);
            expect(markedClaimRequestSent).toHaveLength(1);
            expect(markedClaimRequestSent[0]).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(buildMockLayer()),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'non-training event_type returned by mock (dead-code path, SQL filters) → emits (no type guard in cron)',
    () => {
      // The SQL query already filters event_type = 'training', so in production only
      // training events are returned. The cron no longer has a client-side type guard —
      // it was dead code. If a mock injects a non-training event, the cron processes it
      // normally (emits + marks sent).
      eventsNeedingClaimRequest = [makeClaimEvent(EVENT_ID_1, { event_type: 'match' })];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: Option.some(OWNER_CHANNEL),
        discord_role_id: Option.none(),
      });

      return trainingClaimRequestCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedClaimRequests).toHaveLength(1);
            expect(markedClaimRequestSent).toHaveLength(1);
          }),
        ),
        Effect.provide(buildMockLayer()),
        Effect.asVoid,
      );
    },
  );

  it.effect('owner_group_id is None → no emit, but marks sent (avoids infinite rescan)', () => {
    eventsNeedingClaimRequest = [makeClaimEvent(EVENT_ID_1, { owner_group_id: Option.none() })];

    return trainingClaimRequestCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedClaimRequests).toHaveLength(0);
          // Must mark sent so the event is not returned on every subsequent tick
          expect(markedClaimRequestSent).toHaveLength(1);
          expect(markedClaimRequestSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  it.effect(
    'training with no channel mapping → no emit, still marks sent (avoids infinite rescan)',
    () => {
      // When there is no owner channel, the cron should warn but STILL mark sent
      // so the event is not rescanned on every tick.
      eventsNeedingClaimRequest = [makeClaimEvent(EVENT_ID_1)];
      // No channel mapping in store

      return trainingClaimRequestCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedClaimRequests).toHaveLength(0);
            expect(markedClaimRequestSent).toHaveLength(1);
            expect(markedClaimRequestSent[0]).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(buildMockLayer()),
        Effect.asVoid,
      );
    },
  );

  it.effect('no pending events → nothing emitted, nothing marked', () => {
    eventsNeedingClaimRequest = [];

    return trainingClaimRequestCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedClaimRequests).toHaveLength(0);
          expect(markedClaimRequestSent).toHaveLength(0);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  it.effect(
    'markClaimRequestSent called even when emitTrainingClaimRequest resolves — idempotency on second tick',
    () => {
      // Re-run after first run: findEventsNeedingClaimRequest returns empty (already marked)
      eventsNeedingClaimRequest = [makeClaimEvent(EVENT_ID_1)];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: Option.some(OWNER_CHANNEL),
        discord_role_id: Option.none(),
      });

      const layer = buildMockLayer();

      return Effect.Do.pipe(
        Effect.tap(() => trainingClaimRequestCronEffect.pipe(Effect.provide(layer))),
        Effect.tap(() =>
          Effect.sync(() => {
            // Simulate second tick: nothing pending anymore (DB was marked)
            eventsNeedingClaimRequest = [];
          }),
        ),
        Effect.tap(() => trainingClaimRequestCronEffect.pipe(Effect.provide(layer))),
        Effect.tap(() =>
          Effect.sync(() => {
            // Only one emit and one mark from the first tick
            expect(emittedClaimRequests).toHaveLength(1);
            expect(markedClaimRequestSent).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      ) as Effect.Effect<void, never, never>;
    },
  );
});
