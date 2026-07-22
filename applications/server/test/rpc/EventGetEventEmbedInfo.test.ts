// NOTE: This test is written in TDD mode BEFORE the implementation.
//
// It drives the REAL `Event/GetEventEmbedInfo` RPC handler (src/rpc/event/index.ts)
// through EventsRpcLive + RpcTest.makeClient — not a hand-rolled EventEmbedInfo
// constructed inline in the test — so it actually exercises the mapping the
// handler performs from `findEventByIdWithDetails` row -> EventEmbedInfo.
//
// Why this matters: EventEmbedInfo.status uses
// `Schema.withDecodingDefaultKey(() => 'active')`, so if the handler forgets to
// pass `status: row.status` when constructing the response, the RPC call still
// "succeeds" and silently decodes status as 'active' — the bug goes completely
// unnoticed. This test asserts the returned status equals the DB row's REAL
// status ('started' / 'cancelled'), which only holds once the handler is fixed.
//
// This test WILL FAIL until `Event/GetEventEmbedInfo` in
// applications/server/src/rpc/event/index.ts passes `status: row.status`.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { EventsRpcLive } from '~/rpc/event/index.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;

const EVENT_ACTIVE = '00000000-0000-0000-0000-000000000070' as Event.EventId;
const EVENT_STARTED = '00000000-0000-0000-0000-000000000071' as Event.EventId;
const EVENT_CANCELLED = '00000000-0000-0000-0000-000000000072' as Event.EventId;

// ---------------------------------------------------------------------------
// In-memory store — one row per status, mirroring the shape
// EventsRepository#findEventByIdWithDetails returns (EventWithDetails).
// ---------------------------------------------------------------------------

type EventWithDetailsRow = {
  id: Event.EventId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  event_type: Event.EventType;
  title: string;
  description: Option.Option<string>;
  image_url: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  location_url: Option.Option<string>;
  status: Event.EventStatus;
  created_by: TeamMember.TeamMemberId;
  training_type_name: Option.Option<string>;
  created_by_name: Option.Option<string>;
  series_id: Option.Option<string>;
  series_modified: boolean;
  owner_group_id: Option.Option<GroupModel.GroupId>;
  owner_group_name: Option.Option<string>;
  member_group_id: Option.Option<GroupModel.GroupId>;
  member_group_name: Option.Option<string>;
  reminder_sent_at: Option.Option<DateTime.Utc>;
  claimed_by: Option.Option<TeamMember.TeamMemberId>;
  claimer_name: Option.Option<string>;
  claim_discord_channel_id: Option.Option<Discord.Snowflake>;
  claim_discord_message_id: Option.Option<Discord.Snowflake>;
  all_day: boolean;
  personal_messages_dirty_at: Option.Option<DateTime.Utc>;
};

let eventsStore: Map<Event.EventId, EventWithDetailsRow>;

const makeRow = (
  id: Event.EventId,
  status: Event.EventStatus,
  title: string,
): EventWithDetailsRow => ({
  id,
  team_id: TEAM_ID,
  training_type_id: Option.none(),
  event_type: 'match',
  title,
  description: Option.none(),
  image_url: Option.none(),
  start_at: DateTime.makeUnsafe('2027-08-01T18:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  location_url: Option.none(),
  status,
  created_by: COACH_MEMBER_ID,
  training_type_name: Option.none(),
  created_by_name: Option.none(),
  series_id: Option.none(),
  series_modified: false,
  owner_group_id: Option.none(),
  owner_group_name: Option.none(),
  member_group_id: Option.none(),
  member_group_name: Option.none(),
  reminder_sent_at: Option.none(),
  claimed_by: Option.none(),
  claimer_name: Option.none(),
  claim_discord_channel_id: Option.none(),
  claim_discord_message_id: Option.none(),
  all_day: false,
  personal_messages_dirty_at: Option.none(),
});

const resetStores = () => {
  eventsStore = new Map();
  eventsStore.set(EVENT_ACTIVE, makeRow(EVENT_ACTIVE, 'active', 'Active Event'));
  eventsStore.set(EVENT_STARTED, makeRow(EVENT_STARTED, 'started', 'Started Event'));
  eventsStore.set(EVENT_CANCELLED, makeRow(EVENT_CANCELLED, 'cancelled', 'Cancelled Event'));
};

// ---------------------------------------------------------------------------
// Mock layers (mirrors test/rpc/EventGetClaimInfo.test.ts's RPC-level harness)
// ---------------------------------------------------------------------------

const makeMockSqlClientLayer = () =>
  Layer.succeed(
    SqlClient.SqlClient,
    Object.assign(
      function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
        return Effect.succeed([] as never[]);
      },
      {
        safe: undefined as any,
        withoutTransforms: function (this: any) {
          return this;
        },
        reserve: Effect.die(new Error('reserve not implemented')),
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> =>
          effect,
        reactive: () => Effect.succeed([] as never[]),
        reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
        unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([] as never[]),
        literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
        in: (..._args: unknown[]) => Effect.succeed([] as never[]),
        insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
        update: (..._args: unknown[]) => Effect.succeed([] as never[]),
        updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
        and: (..._args: unknown[]) => Effect.succeed([] as never[]),
        or: (..._args: unknown[]) => Effect.succeed([] as never[]),
      },
    ) as unknown as SqlClient.SqlClient,
  );

const makeMockEventsRepository = () =>
  Layer.succeed(EventsRepository, {
    findEventByIdWithDetails: (id: Event.EventId) => {
      const ev = eventsStore.get(id);
      return Effect.succeed(ev ? Option.some(ev) : Option.none());
    },
    // Stubs — not exercised by Event/GetEventEmbedInfo.
    findEventsByTeamId: () => Effect.die(new Error('Not implemented')),
    insertEvent: () => Effect.die(new Error('Not implemented')),
    updateEvent: () => Effect.die(new Error('Not implemented')),
    cancelEvent: () => Effect.die(new Error('Not implemented')),
    startEvent: () => Effect.die(new Error('Not implemented')),
    findEventsToStart: () => Effect.die(new Error('Not implemented')),
    getScopedTrainingTypeIds: () => Effect.die(new Error('Not implemented')),
    saveDiscordMessageId: () => Effect.die(new Error('Not implemented')),
    getDiscordMessageId: () => Effect.die(new Error('Not implemented')),
    findEventsByChannelId: () => Effect.die(new Error('Not implemented')),
    markEventSeriesModified: () => Effect.die(new Error('Not implemented')),
    cancelFutureInSeries: () => Effect.die(new Error('Not implemented')),
    updateFutureUnmodifiedInSeries: () => Effect.die(new Error('Not implemented')),
    findUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
    countUpcomingByGuildId: () => Effect.die(new Error('Not implemented')),
    markReminderSent: () => Effect.die(new Error('Not implemented')),
    findClaimInfo: () => Effect.die(new Error('Not implemented')),
    claimTraining: () => Effect.die(new Error('Not implemented')),
    unclaimTraining: () => Effect.die(new Error('Not implemented')),
    saveClaimDiscordMessage: () => Effect.die(new Error('Not implemented')),
  } as any);

const makePassThroughRepositories = () =>
  Layer.mergeAll(
    Layer.succeed(GroupsRepository, {
      getDescendantMemberIds: () => Effect.succeed([]),
      findGroupsByTeamId: () => Effect.succeed([]),
      findGroupById: () => Effect.succeed(Option.none()),
      insertGroup: () => Effect.die(new Error('Not implemented')),
      updateGroupById: () => Effect.die(new Error('Not implemented')),
      archiveGroupById: () => Effect.void,
      moveGroup: () => Effect.die(new Error('Not implemented')),
      findMembersByGroupId: () => Effect.succeed([]),
      addMemberById: () => Effect.void,
      removeMemberById: () => Effect.void,
      getRolesForGroup: () => Effect.succeed([]),
      getMemberCount: () => Effect.succeed(0),
      getChildren: () => Effect.succeed([]),
      getAncestorIds: () => Effect.succeed([]),
      getAncestors: () => Effect.succeed([]),
    } as any),
    Layer.succeed(EventSyncEventsRepository, {
      emitEventCreated: () => Effect.void,
      emitEventUpdated: () => Effect.void,
      emitEventCancelled: () => Effect.void,
      emitRsvpReminder: () => Effect.void,
      emitEventStarted: () => Effect.void,
      emitTrainingClaimUpdate: () => Effect.void,
      emitTrainingClaimRequest: () => Effect.void,
      emitUnclaimedTrainingReminder: () => Effect.void,
      findUnprocessed: () => Effect.succeed([]),
      markProcessed: () => Effect.void,
      markFailed: () => Effect.void,
    } as any),
    Layer.succeed(TeamMembersRepository, {
      findMembershipByIds: () => Effect.succeed(Option.none()),
      findByTeam: () => Effect.succeed([]),
      findByUser: () => Effect.succeed([]),
      findRosterByTeam: () => Effect.succeed([]),
      findRosterMemberByIds: () => Effect.succeed(Option.none()),
      addMember: () => Effect.die(new Error('Not implemented')),
      deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
      getPlayerRoleId: () => Effect.succeed(Option.none()),
      assignRole: () => Effect.void,
      unassignRole: () => Effect.void,
      setJerseyNumber: () => Effect.void,
    } as any),
    Layer.succeed(TeamSettingsRepository, {
      findByTeamId: () => Effect.succeed(Option.none()),
      findByTeam: () => Effect.succeed(Option.none()),
      upsert: () => Effect.die(new Error('Not implemented')),
      getHorizonDays: () => Effect.succeed(30),
      findLateRsvpChannelId: () => Effect.succeed(Option.none()),
      findEventsNeedingReminder: () => Effect.succeed([]),
    } as any),
    Layer.succeed(TeamsRepository, {
      findById: () => Effect.succeed(Option.none()),
      findByGuildId: () => Effect.succeed(Option.none()),
      insert: () => Effect.die(new Error('Not implemented')),
    } as any),
    Layer.succeed(TrainingTypesRepository, {
      findByTeamId: () => Effect.succeed([]),
      findTrainingTypesByTeamId: () => Effect.succeed([]),
      findById: () => Effect.succeed(Option.none()),
      findTrainingTypeById: () => Effect.succeed(Option.none()),
      findByIdWithGroup: () => Effect.succeed(Option.none()),
      findTrainingTypeByIdWithGroup: () => Effect.succeed(Option.none()),
      insert: () => Effect.die(new Error('Not implemented')),
      insertTrainingType: () => Effect.die(new Error('Not implemented')),
      update: () => Effect.die(new Error('Not implemented')),
      updateTrainingType: () => Effect.die(new Error('Not implemented')),
      deleteTrainingType: () => Effect.void,
      deleteTrainingTypeById: () => Effect.void,
    } as any),
    Layer.succeed(EventRsvpsRepository, {
      findRsvpsByEventId: () => Effect.succeed([]),
      findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
      upsertRsvp: () => Effect.die(new Error('Not implemented')),
      countRsvpsByEventId: () => Effect.succeed([]),
      findNonRespondersByEventId: () => Effect.succeed([]),
      findRsvpAttendeesPage: () => Effect.succeed([]),
      countRsvpTotal: () => Effect.succeed(0),
      findYesAttendeesForEmbed: () => Effect.succeed([]),
    } as any),
    Layer.succeed(DiscordChannelMappingRepository, {
      findByGroupId: () => Effect.succeed(Option.none()),
      insert: () => Effect.void,
      insertWithoutRole: () => Effect.void,
      deleteByGroupId: () => Effect.void,
      findAllByTeamId: () => Effect.succeed([]),
      findAllByTeam: () => Effect.succeed([]),
    } as any),
    Layer.succeed(ChannelEventDividersRepository, {
      findByChannelId: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      deleteByChannelId: () => Effect.void,
    } as any),
  );

const MockEventRostersRepositoryLayer = Layer.succeed(EventRostersRepository, {
  findByEventId: () => Effect.succeed(Option.none()),
  link: () => Effect.die(new Error('Not expected')),
  unlink: () => Effect.void,
  setAutoApprove: () => Effect.void,
  saveThreadIfAbsent: () => Effect.succeed(Option.none()),
  clearThread: () => Effect.void,
} as any);

const MockEventRosterRequestsRepositoryLayer = Layer.succeed(EventRosterRequestsRepository, {
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsertApproved: () => Effect.die(new Error('Not expected')),
  upsertPending: () => Effect.die(new Error('Not expected')),
  claimDecision: () => Effect.succeed(Option.none()),
  cancel: () => Effect.succeed(Option.none()),
  saveMessageId: () => Effect.void,
  findPendingByEvent: () => Effect.succeed([]),
  findPendingByRoster: () => Effect.succeed([]),
  wasMemberBefore: () => Effect.succeed(false),
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockEventRosterProvisioningServiceLayer = Layer.succeed(EventRosterProvisioningService, {
  onRsvp: () => Effect.void,
  approve: () => Effect.die(new Error('Not expected')),
  decline: () => Effect.die(new Error('Not expected')),
  backfill: () => Effect.die(new Error('Not expected')),
} as any);

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(makeMockEventsRepository()),
  Layer.provide(makePassThroughRepositories()),
  Layer.provide(makeMockSqlClientLayer()),
  Layer.provide(MockEventRostersRepositoryLayer),
  Layer.provide(MockEventRosterRequestsRepositoryLayer),
  Layer.provide(MockEventRosterProvisioningServiceLayer),
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Event/GetEventEmbedInfo — real handler must surface the DB row's real status
// ---------------------------------------------------------------------------

const callGetEventEmbedInfo = (eventId: Event.EventId) =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/GetEventEmbedInfo']({
            event_id: eventId,
          }) as Effect.Effect<Option.Option<EventRpcModels.EventEmbedInfo>, unknown, never>,
      ),
    ),
  );

describe('Event/GetEventEmbedInfo — real handler must return the DB row status (not decode-default "active")', () => {
  itEffect.effect('active event: embedInfo.status is "active"', () =>
    callGetEventEmbedInfo(EVENT_ACTIVE).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) {
            expect(result.value.status).toBe('active');
          }
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );

  itEffect.effect(
    'started event: embedInfo.status is "started", NOT the decode-default "active"',
    () =>
      callGetEventEmbedInfo(EVENT_STARTED).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
            if (Option.isSome(result)) {
              // If the handler forgets `status: row.status`, EventEmbedInfo's
              // withDecodingDefaultKey silently fills in 'active' here instead
              // — this assertion is what catches that regression.
              expect(result.value.status).toBe('started');
              expect(result.value.status).not.toBe('active');
            }
          }),
        ),
        Effect.provide(RpcTestLayer),
        Effect.asVoid,
      ),
  );

  itEffect.effect('cancelled event: embedInfo.status is "cancelled", NOT "active"', () =>
    callGetEventEmbedInfo(EVENT_CANCELLED).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) {
            expect(result.value.status).toBe('cancelled');
            expect(result.value.status).not.toBe('active');
          }
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );
});
