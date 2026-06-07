// NOTE: TDD mode — tests reference Event/GetClaimInfo which is stubbed with Effect.die.
// Tests WILL FAIL at runtime until the handler is implemented.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { EventRpcGroup, EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { EventsRpcLive } from '~/rpc/event/index.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;

const EVENT_UNCLAIMED = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const EVENT_CLAIMED = '00000000-0000-0000-0000-000000000061' as Event.EventId;
const BOGUS_EVENT_ID = '99999999-9999-9999-9999-999999999999' as Event.EventId;

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

type EventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  event_type: Event.EventType;
  title: string;
  description: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  status: Event.EventStatus;
  created_by: TeamMember.TeamMemberId;
  owner_group_id: Option.Option<GroupModel.GroupId>;
  member_group_id: Option.Option<GroupModel.GroupId>;
  claimed_by: Option.Option<TeamMember.TeamMemberId>;
  training_type_id: Option.Option<string>;
  training_type_name: Option.Option<string>;
  created_by_name: Option.Option<string>;
  series_id: Option.Option<string>;
  series_modified: boolean;
  discord_target_channel_id: Option.Option<Discord.Snowflake>;
  owner_group_name: Option.Option<string>;
  member_group_name: Option.Option<string>;
  reminder_sent_at: Option.Option<DateTime.Utc>;
};

let eventsStore: Map<Event.EventId, EventRecord>;

const makeBaseEvent = (id: Event.EventId, overrides: Partial<EventRecord> = {}): EventRecord => ({
  id,
  team_id: TEAM_ID,
  event_type: 'training',
  title: 'Test Training',
  description: Option.none(),
  start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  status: 'active',
  created_by: COACH_MEMBER_ID,
  owner_group_id: Option.some(OWNER_GROUP_ID),
  member_group_id: Option.none(),
  claimed_by: Option.none(),
  training_type_id: Option.none(),
  training_type_name: Option.none(),
  created_by_name: Option.none(),
  series_id: Option.none(),
  series_modified: false,
  discord_target_channel_id: Option.none(),
  owner_group_name: Option.none(),
  member_group_name: Option.none(),
  reminder_sent_at: Option.none(),
  ...overrides,
});

const resetStores = () => {
  eventsStore = new Map();

  eventsStore.set(
    EVENT_UNCLAIMED,
    makeBaseEvent(EVENT_UNCLAIMED, {
      title: 'Unclaimed Training',
      claimed_by: Option.none(),
    }),
  );

  eventsStore.set(
    EVENT_CLAIMED,
    makeBaseEvent(EVENT_CLAIMED, {
      title: 'Claimed Training',
      claimed_by: Option.some(COACH_MEMBER_ID),
    }),
  );
};

// ---------------------------------------------------------------------------
// Mock layers
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
    findEventsByTeamId: () => Effect.succeed([]),
    insertEvent: () => Effect.die(new Error('Not implemented')),
    updateEvent: () => Effect.die(new Error('Not implemented')),
    cancelEvent: () => Effect.void,
    getScopedTrainingTypeIds: () => Effect.succeed([]),
    saveDiscordMessageId: () => Effect.void,
    getDiscordMessageId: () => Effect.succeed(Option.none()),
    findEventsByChannelId: () => Effect.succeed([]),
    markEventSeriesModified: () => Effect.void,
    cancelFutureInSeries: () => Effect.void,
    updateFutureUnmodifiedInSeries: () => Effect.void,
    findUpcomingByGuildId: () => Effect.succeed([]),
    countUpcomingByGuildId: () => Effect.succeed(0),
    markReminderSent: () => Effect.void,
    // New method for claim info
    findClaimInfo: (id: Event.EventId) => {
      const ev = eventsStore.get(id);
      if (!ev) return Effect.succeed(Option.none());
      return Effect.succeed(
        Option.some(
          new EventRpcModels.EventClaimInfo({
            event_id: ev.id,
            event_type: ev.event_type,
            status: ev.status,
            claimed_by_member_id: ev.claimed_by,
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.none(),
            claim_discord_message_id: Option.none(),
            claim_thread_id: Option.none(),
          }),
        ),
      );
    },
    claimTraining: () => Effect.succeed(Option.none()),
    unclaimTraining: () => Effect.succeed(Option.none()),
    saveClaimDiscordMessage: () => Effect.void,
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

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(makeMockEventsRepository()),
  Layer.provide(makePassThroughRepositories()),
  Layer.provide(makeMockSqlClientLayer()),
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Case 10: GetClaimInfo returns None for non-existent event
// ---------------------------------------------------------------------------

describe('Event/GetClaimInfo — non-existent event', () => {
  itEffect.effect('returns None for a bogus event_id', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/GetClaimInfo']({
              event_id: BOGUS_EVENT_ID,
            }) as Effect.Effect<Option.Option<EventRpcModels.EventClaimInfo>, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 11: GetClaimInfo returns Some with full claim info
// ---------------------------------------------------------------------------

describe('Event/GetClaimInfo — existing event', () => {
  itEffect.effect('returns Some with claimed_by_member_id = None for unclaimed event', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/GetClaimInfo']({
              event_id: EVENT_UNCLAIMED,
            }) as Effect.Effect<Option.Option<EventRpcModels.EventClaimInfo>, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) {
            const info = result.value;
            expect(Option.isNone(info.claimed_by_member_id)).toBe(true);
            expect(info.event_type).toBe('training');
            expect(info.status).toBe('active');
          }
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );

  itEffect.effect('returns Some with claimed_by_member_id = Some for claimed event', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/GetClaimInfo']({
              event_id: EVENT_CLAIMED,
            }) as Effect.Effect<Option.Option<EventRpcModels.EventClaimInfo>, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) {
            const info = result.value;
            expect(Option.isSome(info.claimed_by_member_id)).toBe(true);
            if (Option.isSome(info.claimed_by_member_id)) {
              expect(info.claimed_by_member_id.value).toBe(COACH_MEMBER_ID);
            }
          }
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );
});
