// NOTE: These tests are written in TDD mode BEFORE the implementation of the
// Event/SubmitJoinRequest, Event/AcceptJoinRequest, Event/DeclineJoinRequest,
// Event/GetAttendanceOverview, and Event/SaveJoinRequestMessageId RPC handlers.
// They reference a new repository (EventJoinRequestsRepository) that does not yet exist.
// They WILL FAIL at runtime with defect errors from the stub Effect.die() handlers.
// That is expected and correct — the developer will implement the handlers to make
// these tests pass.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { EventRpcGroup, EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventJoinRequestsRepository } from '~/repositories/EventJoinRequestsRepository.js';
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

// Members: captain can manage roster; requester is a plain member; non-member unknown
const CAPTAIN_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '222222222222222222' as Discord.Snowflake;
const OTHER_MEMBER_DISCORD_ID = '333333333333333333' as Discord.Snowflake;
const NON_MEMBER_DISCORD_ID = '999999999999999999' as Discord.Snowflake;

const CAPTAIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const OTHER_MEMBER_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;

const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;

// Events
const EVENT_ACTIVE_TOURNAMENT = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const EVENT_ACTIVE_TRAINING = '00000000-0000-0000-0000-000000000061' as Event.EventId;
const EVENT_CANCELLED = '00000000-0000-0000-0000-000000000062' as Event.EventId;
const EVENT_STARTED = '00000000-0000-0000-0000-000000000063' as Event.EventId;
const BOGUS_EVENT_ID = '99999999-9999-9999-9999-999999999999' as Event.EventId;

// Join request IDs
const JOIN_REQUEST_PENDING_ID =
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as EventRpcModels.JoinRequestId;
const JOIN_REQUEST_DECIDED_ID =
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as EventRpcModels.JoinRequestId;

// ---------------------------------------------------------------------------
// In-memory event store
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
  claimer_name: Option.Option<string>;
  claim_discord_channel_id: Option.Option<Discord.Snowflake>;
  claim_discord_message_id: Option.Option<Discord.Snowflake>;
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

// In-memory join requests store
type JoinRequestRecord = {
  id: EventRpcModels.JoinRequestId;
  event_id: Event.EventId;
  team_member_id: TeamMember.TeamMemberId;
  status: EventRpcModels.JoinRequestStatus;
  member_display_name: Option.Option<string>;
  member_discord_id: Option.Option<Discord.Snowflake>;
  message: Option.Option<string>;
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_message_id: Option.Option<Discord.Snowflake>;
  decided_by: Option.Option<TeamMember.TeamMemberId>;
  decided_by_display_name: Option.Option<string>;
};

let eventsStore: Map<Event.EventId, EventRecord>;
let joinRequestsStore: Map<EventRpcModels.JoinRequestId, JoinRequestRecord>;

// Track emitted sync events for assertion
type EmittedJoinRequestEvent = {
  type: 'tournament_join_request';
  eventId: Event.EventId;
  requestId: EventRpcModels.JoinRequestId;
  requesterDisplayName: Option.Option<string>;
};
type EmittedAttendanceUpdateEvent = {
  type: 'tournament_attendance_update';
  eventId: Event.EventId;
  requestId: EventRpcModels.JoinRequestId;
  status: string;
  decidedByDisplayName: Option.Option<string>;
};
type EmittedSyncEvent = EmittedJoinRequestEvent | EmittedAttendanceUpdateEvent;
let emittedSyncEvents: EmittedSyncEvent[];

const makeBaseEvent = (id: Event.EventId, overrides: Partial<EventRecord> = {}): EventRecord => ({
  id,
  team_id: TEAM_ID,
  event_type: 'tournament',
  title: 'Summer Tournament',
  description: Option.none(),
  start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  status: 'active',
  created_by: CAPTAIN_MEMBER_ID,
  owner_group_id: Option.some(OWNER_GROUP_ID),
  member_group_id: Option.none(),
  claimed_by: Option.none(),
  claimer_name: Option.none(),
  claim_discord_channel_id: Option.none(),
  claim_discord_message_id: Option.none(),
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
  joinRequestsStore = new Map();
  emittedSyncEvents = [];

  // Active tournament
  eventsStore.set(
    EVENT_ACTIVE_TOURNAMENT,
    makeBaseEvent(EVENT_ACTIVE_TOURNAMENT, {
      event_type: 'tournament',
      title: 'Summer Tournament',
      status: 'active',
    }),
  );

  // Active training (non-tournament)
  eventsStore.set(
    EVENT_ACTIVE_TRAINING,
    makeBaseEvent(EVENT_ACTIVE_TRAINING, {
      event_type: 'training',
      title: 'Weekly Training',
      status: 'active',
    }),
  );

  // Cancelled tournament
  eventsStore.set(
    EVENT_CANCELLED,
    makeBaseEvent(EVENT_CANCELLED, {
      event_type: 'tournament',
      title: 'Cancelled Tournament',
      status: 'cancelled',
    }),
  );

  // Started tournament
  eventsStore.set(
    EVENT_STARTED,
    makeBaseEvent(EVENT_STARTED, {
      event_type: 'tournament',
      title: 'Started Tournament',
      status: 'started',
    }),
  );

  // Pre-seed a pending join request for MEMBER_MEMBER_ID on EVENT_ACTIVE_TOURNAMENT
  joinRequestsStore.set(JOIN_REQUEST_PENDING_ID, {
    id: JOIN_REQUEST_PENDING_ID,
    event_id: EVENT_ACTIVE_TOURNAMENT,
    team_member_id: MEMBER_MEMBER_ID,
    status: 'pending',
    member_display_name: Option.some('Member User'),
    member_discord_id: Option.some(MEMBER_DISCORD_ID),
    message: Option.none(),
    discord_channel_id: Option.none(),
    discord_message_id: Option.none(),
    decided_by: Option.none(),
    decided_by_display_name: Option.none(),
  });

  // Pre-seed an already-decided (accepted) join request for OTHER_MEMBER
  joinRequestsStore.set(JOIN_REQUEST_DECIDED_ID, {
    id: JOIN_REQUEST_DECIDED_ID,
    event_id: EVENT_ACTIVE_TOURNAMENT,
    team_member_id: OTHER_MEMBER_MEMBER_ID,
    status: 'accepted',
    member_display_name: Option.some('Other Member'),
    member_discord_id: Option.some(OTHER_MEMBER_DISCORD_ID),
    message: Option.none(),
    discord_channel_id: Option.none(),
    discord_message_id: Option.none(),
    decided_by: Option.some(CAPTAIN_MEMBER_ID),
    decided_by_display_name: Option.some('Captain User'),
  });
};

// ---------------------------------------------------------------------------
// Mock SQL layer (member lookup by discord_id)
// ---------------------------------------------------------------------------

const makeMockSqlClientLayer = () =>
  Layer.succeed(
    SqlClient.SqlClient,
    Object.assign(
      function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
        // Inspect args to determine which discord_id is being looked up
        const discordId = _args.find(
          (a) => typeof a === 'string' && /^\d{17,20}$/.test(a as string),
        );
        if (discordId === CAPTAIN_DISCORD_ID) {
          return Effect.succeed([
            {
              id: CAPTAIN_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Captain User',
              username: null,
            },
          ]);
        }
        if (discordId === MEMBER_DISCORD_ID) {
          return Effect.succeed([
            {
              id: MEMBER_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Member User',
              username: null,
            },
          ]);
        }
        if (discordId === OTHER_MEMBER_DISCORD_ID) {
          return Effect.succeed([
            {
              id: OTHER_MEMBER_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Other Member',
              username: null,
            },
          ]);
        }
        // NON_MEMBER_DISCORD_ID or unknown → no row
        return Effect.succeed([]);
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

// ---------------------------------------------------------------------------
// Mock EventJoinRequestsRepository
// ---------------------------------------------------------------------------

const toEntry = (r: JoinRequestRecord) =>
  new EventRpcModels.JoinRequestEntry({
    id: r.id,
    event_id: r.event_id,
    team_member_id: r.team_member_id,
    status: r.status,
    member_display_name: r.member_display_name,
    member_discord_id: r.member_discord_id,
    message: r.message,
    discord_channel_id: r.discord_channel_id,
    discord_message_id: r.discord_message_id,
  });

const makeMockEventJoinRequestsRepository = () =>
  Layer.succeed(EventJoinRequestsRepository, {
    /**
     * submit: mirrors the upsert contract:
     * - fresh insert → { entry, created: true }
     * - declined row reopened to pending → { entry, created: true }
     * - pending/accepted row unchanged → { entry, created: false }
     */
    submit: (
      eventId: Event.EventId,
      memberId: TeamMember.TeamMemberId,
      memberDisplayName: Option.Option<string>,
      memberDiscordId: Option.Option<Discord.Snowflake>,
      message: Option.Option<string>,
    ) => {
      const existing = [...joinRequestsStore.values()].find(
        (r) => r.event_id === eventId && r.team_member_id === memberId,
      );
      if (existing) {
        if (existing.status === 'declined') {
          // Reopen to pending (B4)
          const reopened: JoinRequestRecord = {
            ...existing,
            status: 'pending',
            decided_by: Option.none(),
            decided_by_display_name: Option.none(),
            message,
          };
          joinRequestsStore.set(existing.id, reopened);
          return Effect.succeed({ entry: toEntry(reopened), created: true });
        }
        // pending or accepted — no change
        return Effect.succeed({ entry: toEntry(existing), created: false });
      }
      const newId = `new-${memberId}` as EventRpcModels.JoinRequestId;
      const newRequest: JoinRequestRecord = {
        id: newId,
        event_id: eventId,
        team_member_id: memberId,
        status: 'pending',
        member_display_name: memberDisplayName,
        member_discord_id: memberDiscordId,
        message,
        discord_channel_id: Option.none(),
        discord_message_id: Option.none(),
        decided_by: Option.none(),
        decided_by_display_name: Option.none(),
      };
      joinRequestsStore.set(newId, newRequest);
      return Effect.succeed({ entry: toEntry(newRequest), created: true });
    },

    // accept: guarded UPDATE scoped by team_id (B3) — returns None if not pending or wrong team
    accept: (
      requestId: EventRpcModels.JoinRequestId,
      decidedByMemberId: TeamMember.TeamMemberId,
      teamId: Team.TeamId,
    ) => {
      const req = joinRequestsStore.get(requestId);
      // B3: also check the event belongs to teamId (in the mock, event team_id is always TEAM_ID)
      const eventTeamId = req ? eventsStore.get(req.event_id)?.team_id : undefined;
      if (req?.status !== 'pending' || eventTeamId !== teamId) {
        return Effect.succeed(Option.none<EventRpcModels.JoinRequestEntry>());
      }
      const updated: JoinRequestRecord = {
        ...req,
        status: 'accepted',
        decided_by: Option.some(decidedByMemberId),
        decided_by_display_name: Option.none(),
      };
      joinRequestsStore.set(requestId, updated);
      return Effect.succeed(Option.some(toEntry(updated)));
    },

    // decline: guarded UPDATE scoped by team_id (B3) — returns None if not pending or wrong team
    decline: (
      requestId: EventRpcModels.JoinRequestId,
      decidedByMemberId: TeamMember.TeamMemberId,
      teamId: Team.TeamId,
    ) => {
      const req = joinRequestsStore.get(requestId);
      // B3: also check the event belongs to teamId
      const eventTeamId = req ? eventsStore.get(req.event_id)?.team_id : undefined;
      if (req?.status !== 'pending' || eventTeamId !== teamId) {
        return Effect.succeed(Option.none<EventRpcModels.JoinRequestEntry>());
      }
      const updated: JoinRequestRecord = {
        ...req,
        status: 'declined',
        decided_by: Option.some(decidedByMemberId),
        decided_by_display_name: Option.none(),
      };
      joinRequestsStore.set(requestId, updated);
      return Effect.succeed(Option.some(toEntry(updated)));
    },

    // saveDiscordMessageId: persist channel + message id on a request
    saveDiscordMessageId: (
      requestId: EventRpcModels.JoinRequestId,
      channelId: Discord.Snowflake,
      messageId: Discord.Snowflake,
    ) => {
      const req = joinRequestsStore.get(requestId);
      if (req) {
        joinRequestsStore.set(requestId, {
          ...req,
          discord_channel_id: Option.some(channelId),
          discord_message_id: Option.some(messageId),
        });
      }
      return Effect.void;
    },

    // findOverview: returns accepted + pending requests for an event (excludes declined)
    findOverview: (eventId: Event.EventId) => {
      const all = [...joinRequestsStore.values()].filter((r) => r.event_id === eventId);
      const accepted = all.filter((r) => r.status === 'accepted').map(toEntry);
      const pending = all.filter((r) => r.status === 'pending').map(toEntry);
      return Effect.succeed(
        new EventRpcModels.AttendanceOverview({ event_id: eventId, accepted, pending }),
      );
    },

    // findRequestById: lookup a single request
    findRequestById: (requestId: EventRpcModels.JoinRequestId) => {
      const req = joinRequestsStore.get(requestId);
      if (!req) return Effect.succeed(Option.none());
      return Effect.succeed(Option.some(toEntry(req)));
    },

    // hasRosterManagePermission: checks if a member has roster:manage on the event's team
    hasRosterManagePermission: (memberId: TeamMember.TeamMemberId, _teamId: Team.TeamId) => {
      // Only CAPTAIN_MEMBER_ID has roster:manage in tests
      return Effect.succeed(memberId === CAPTAIN_MEMBER_ID);
    },
  } as any);

// ---------------------------------------------------------------------------
// Mock repository layers (passthrough stubs)
// ---------------------------------------------------------------------------

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
    claimTraining: () => Effect.succeed(Option.none()),
    unclaimTraining: () => Effect.succeed(Option.none()),
    findClaimInfo: () => Effect.succeed(Option.none()),
    saveClaimDiscordMessage: () => Effect.void,
  } as any);

const makeMockGroupsRepository = (rosterManageMemberIds: TeamMember.TeamMemberId[]) =>
  Layer.succeed(GroupsRepository, {
    getDescendantMemberIds: (_groupId: GroupModel.GroupId) => Effect.succeed(rosterManageMemberIds),
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
  } as any);

const makeMockSyncEventsRepository = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitEventStarted: () => Effect.void,
    emitTrainingClaimUpdate: () => Effect.void,
    emitTrainingClaimRequest: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
    emitCoachingStatus: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    // New emitters for tournament join requests
    emitTournamentJoinRequest: (
      _teamId: Team.TeamId,
      eventId: Event.EventId,
      requestId: EventRpcModels.JoinRequestId,
      requesterDisplayName: Option.Option<string>,
      _requesterDiscordId: Option.Option<Discord.Snowflake>,
      _requestMessage: Option.Option<string>,
      _joinRequestDiscordChannelId: Option.Option<Discord.Snowflake>,
      _joinRequestDiscordMessageId: Option.Option<Discord.Snowflake>,
    ) => {
      emittedSyncEvents.push({
        type: 'tournament_join_request',
        eventId,
        requestId,
        requesterDisplayName,
      });
      return Effect.void;
    },
    emitTournamentAttendanceUpdate: (
      _teamId: Team.TeamId,
      eventId: Event.EventId,
      requestId: EventRpcModels.JoinRequestId,
      status: string,
      decidedByDisplayName: Option.Option<string>,
      _requesterDisplayName: Option.Option<string>,
      _joinRequestDiscordChannelId: Option.Option<Discord.Snowflake>,
      _joinRequestDiscordMessageId: Option.Option<Discord.Snowflake>,
    ) => {
      emittedSyncEvents.push({
        type: 'tournament_attendance_update',
        eventId,
        requestId,
        status,
        decidedByDisplayName,
      });
      return Effect.void;
    },
  } as any);

const makeMockTeamMembersRepository = () =>
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
  } as any);

const makeMockTeamSettingsRepository = () =>
  Layer.succeed(TeamSettingsRepository, {
    findByTeamId: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
    findEventsNeedingReminder: () => Effect.succeed([]),
  } as any);

const makeMockTeamsRepository = () =>
  Layer.succeed(TeamsRepository, {
    findById: () => Effect.succeed(Option.none()),
    findByGuildId: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
  } as any);

const makeMockTrainingTypesRepository = () =>
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
  } as any);

const makeMockEventRsvpsRepository = () =>
  Layer.succeed(EventRsvpsRepository, {
    findRsvpsByEventId: () => Effect.succeed([]),
    findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
    upsertRsvp: () => Effect.die(new Error('Not implemented')),
    countRsvpsByEventId: () => Effect.succeed([]),
    findNonRespondersByEventId: () => Effect.succeed([]),
    findRsvpAttendeesPage: () => Effect.succeed([]),
    countRsvpTotal: () => Effect.succeed(0),
    findYesAttendeesForEmbed: () => Effect.succeed([]),
  } as any);

const makeMockDiscordChannelMappingRepository = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: () => Effect.succeed(Option.none()),
    insert: () => Effect.void,
    insertWithoutRole: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    findAllByTeamId: () => Effect.succeed([]),
    findAllByTeam: () => Effect.succeed([]),
  } as any);

const makeMockChannelEventDividersRepository = () =>
  Layer.succeed(ChannelEventDividersRepository, {
    findByChannelId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.void,
    deleteByChannelId: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Build RPC test layer
// ---------------------------------------------------------------------------

const buildRpcTestLayer = (
  rosterManageMemberIds: TeamMember.TeamMemberId[] = [CAPTAIN_MEMBER_ID],
) =>
  EventsRpcLive.pipe(
    Layer.provide(makeMockEventsRepository()),
    Layer.provide(makeMockEventJoinRequestsRepository()),
    Layer.provide(makeMockGroupsRepository(rosterManageMemberIds)),
    Layer.provide(makeMockSyncEventsRepository()),
    Layer.provide(makeMockTeamMembersRepository()),
    Layer.provide(makeMockTeamSettingsRepository()),
    Layer.provide(makeMockTeamsRepository()),
    Layer.provide(makeMockTrainingTypesRepository()),
    Layer.provide(makeMockEventRsvpsRepository()),
    Layer.provide(makeMockDiscordChannelMappingRepository()),
    Layer.provide(makeMockChannelEventDividersRepository()),
    Layer.provide(makeMockSqlClientLayer()),
  );

// ---------------------------------------------------------------------------
// RPC call helpers
// ---------------------------------------------------------------------------

const callSubmitJoinRequest = (params: {
  event_id: Event.EventId;
  team_id?: Team.TeamId;
  discord_user_id: Discord.Snowflake;
  message?: Option.Option<string>;
  rosterManageMemberIds?: TeamMember.TeamMemberId[];
}) => {
  const layer = buildRpcTestLayer(params.rosterManageMemberIds);
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/SubmitJoinRequest']({
            event_id: params.event_id,
            team_id: params.team_id ?? TEAM_ID,
            discord_user_id: params.discord_user_id,
            message: params.message ?? Option.none(),
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

const callAcceptJoinRequest = (params: {
  request_id: EventRpcModels.JoinRequestId;
  team_id?: Team.TeamId;
  discord_user_id: Discord.Snowflake;
  rosterManageMemberIds?: TeamMember.TeamMemberId[];
}) => {
  const layer = buildRpcTestLayer(params.rosterManageMemberIds);
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/AcceptJoinRequest']({
            request_id: params.request_id,
            team_id: params.team_id ?? TEAM_ID,
            discord_user_id: params.discord_user_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

const callDeclineJoinRequest = (params: {
  request_id: EventRpcModels.JoinRequestId;
  team_id?: Team.TeamId;
  discord_user_id: Discord.Snowflake;
  rosterManageMemberIds?: TeamMember.TeamMemberId[];
}) => {
  const layer = buildRpcTestLayer(params.rosterManageMemberIds);
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/DeclineJoinRequest']({
            request_id: params.request_id,
            team_id: params.team_id ?? TEAM_ID,
            discord_user_id: params.discord_user_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

const callGetAttendanceOverview = (params: { event_id: Event.EventId }) => {
  const layer = buildRpcTestLayer();
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/GetAttendanceOverview']({
            event_id: params.event_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

const callSaveJoinRequestMessageId = (params: {
  request_id: EventRpcModels.JoinRequestId;
  channel_id: Discord.Snowflake;
  message_id: Discord.Snowflake;
}) => {
  const layer = buildRpcTestLayer();
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/SaveJoinRequestMessageId']({
            request_id: params.request_id,
            channel_id: params.channel_id,
            message_id: params.message_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Case 1: SubmitJoinRequest happy path
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — happy path', () => {
  itEffect.effect(
    'tournament + active + member → returns { status: pending, created: true } and emits tournament_join_request',
    () =>
      callSubmitJoinRequest({
        event_id: EVENT_ACTIVE_TOURNAMENT,
        discord_user_id: CAPTAIN_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.status).toBe('pending');
            // B4: created must be true for a fresh request
            expect(result.created).toBe(true);

            // A tournament_join_request sync event must have been emitted
            const emitted = emittedSyncEvents.filter(
              (e) => e.type === 'tournament_join_request' && e.eventId === EVENT_ACTIVE_TOURNAMENT,
            ) as EmittedJoinRequestEvent[];
            expect(emitted).toHaveLength(1);
            // requester_display_name must be set (not None)
            expect(Option.isSome(emitted[0].requesterDisplayName)).toBe(true);
            if (Option.isSome(emitted[0].requesterDisplayName)) {
              expect(emitted[0].requesterDisplayName.value).toBe('Captain User');
            }
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 2: SubmitJoinRequest duplicate — idempotent
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — duplicate (idempotent)', () => {
  itEffect.effect(
    'same member submits twice → returns existing pending row, created=false, NO sync event emitted',
    () => {
      // MEMBER_MEMBER_ID already has a pending request (JOIN_REQUEST_PENDING_ID)
      return callSubmitJoinRequest({
        event_id: EVENT_ACTIVE_TOURNAMENT,
        discord_user_id: MEMBER_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Returns existing request — still pending
            expect(result.status).toBe('pending');
            // request_id must equal the pre-seeded one
            expect(result.request_id).toBe(JOIN_REQUEST_PENDING_ID);
            // B4: created must be false — row already exists as pending
            expect(result.created).toBe(false);
            // No new entries created
            const all = [...joinRequestsStore.values()].filter(
              (r) =>
                r.event_id === EVENT_ACTIVE_TOURNAMENT && r.team_member_id === MEMBER_MEMBER_ID,
            );
            expect(all).toHaveLength(1);
            // reviewer #11 / B4: duplicate submit must NOT emit a new tournament_join_request
            const emitted = emittedSyncEvents.filter((e) => e.type === 'tournament_join_request');
            expect(emitted).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 3: SubmitJoinRequest non-member
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — non-member', () => {
  itEffect.effect('discord id not on team → JoinRequestNotMember', () =>
    callSubmitJoinRequest({
      event_id: EVENT_ACTIVE_TOURNAMENT,
      discord_user_id: NON_MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 4: SubmitJoinRequest non-tournament event
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — non-tournament event', () => {
  itEffect.effect('training event → JoinRequestNotTournament', () =>
    callSubmitJoinRequest({
      event_id: EVENT_ACTIVE_TRAINING,
      discord_user_id: MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestNotTournament');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 5: SubmitJoinRequest inactive event
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — inactive event', () => {
  itEffect.effect('cancelled tournament → JoinRequestEventInactive', () =>
    callSubmitJoinRequest({
      event_id: EVENT_CANCELLED,
      discord_user_id: MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestEventInactive');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('started tournament → JoinRequestEventInactive', () =>
    callSubmitJoinRequest({
      event_id: EVENT_STARTED,
      discord_user_id: MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestEventInactive');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 6: SubmitJoinRequest unknown event
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — event not found', () => {
  itEffect.effect('bogus event_id → JoinRequestEventNotFound', () =>
    callSubmitJoinRequest({
      event_id: BOGUS_EVENT_ID,
      discord_user_id: MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestEventNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 7: AcceptJoinRequest happy path
// ---------------------------------------------------------------------------

describe('Event/AcceptJoinRequest — happy path', () => {
  itEffect.effect(
    'decider has roster:manage → status accepted, emits tournament_attendance_update with status=accepted and decided_by_display_name',
    () =>
      callAcceptJoinRequest({
        request_id: JOIN_REQUEST_PENDING_ID,
        discord_user_id: CAPTAIN_DISCORD_ID,
        rosterManageMemberIds: [CAPTAIN_MEMBER_ID],
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.status).toBe('accepted');
            expect(result.request_id).toBe(JOIN_REQUEST_PENDING_ID);

            // The join request in store must be updated
            const req = joinRequestsStore.get(JOIN_REQUEST_PENDING_ID);
            expect(req?.status).toBe('accepted');

            // tournament_attendance_update must have been emitted
            const emitted = emittedSyncEvents.filter(
              (e) => e.type === 'tournament_attendance_update',
            ) as EmittedAttendanceUpdateEvent[];
            expect(emitted).toHaveLength(1);
            expect(emitted[0].status).toBe('accepted');
            expect(Option.isSome(emitted[0].decidedByDisplayName)).toBe(true);
            if (Option.isSome(emitted[0].decidedByDisplayName)) {
              expect(emitted[0].decidedByDisplayName.value).toBe('Captain User');
            }
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 8: AcceptJoinRequest race — already decided
// ---------------------------------------------------------------------------

describe('Event/AcceptJoinRequest — already decided (race)', () => {
  itEffect.effect(
    'request already accepted/declined → JoinRequestAlreadyDecided, no sync event emitted',
    () =>
      callAcceptJoinRequest({
        request_id: JOIN_REQUEST_DECIDED_ID,
        discord_user_id: CAPTAIN_DISCORD_ID,
        rosterManageMemberIds: [CAPTAIN_MEMBER_ID],
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              const err = result.failure as any;
              expect(err._tag).toBe('JoinRequestAlreadyDecided');
            }
            // No sync events emitted
            const updateEvents = emittedSyncEvents.filter(
              (e) => e.type === 'tournament_attendance_update',
            );
            expect(updateEvents).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 9: AcceptJoinRequest caller lacks roster:manage
// ---------------------------------------------------------------------------

describe('Event/AcceptJoinRequest — forbidden (no roster:manage)', () => {
  itEffect.effect('member without roster:manage → JoinRequestForbidden', () =>
    callAcceptJoinRequest({
      request_id: JOIN_REQUEST_PENDING_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      // MEMBER_MEMBER_ID is not in rosterManageMemberIds
      rosterManageMemberIds: [CAPTAIN_MEMBER_ID],
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 10: AcceptJoinRequest caller not a member
// ---------------------------------------------------------------------------

describe('Event/AcceptJoinRequest — non-member decider', () => {
  itEffect.effect('discord id not on team → JoinRequestNotMember', () =>
    callAcceptJoinRequest({
      request_id: JOIN_REQUEST_PENDING_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 11: DeclineJoinRequest happy path
// ---------------------------------------------------------------------------

describe('Event/DeclineJoinRequest — happy path', () => {
  itEffect.effect(
    'decider has roster:manage → status declined, emits tournament_attendance_update with status=declined',
    () =>
      callDeclineJoinRequest({
        request_id: JOIN_REQUEST_PENDING_ID,
        discord_user_id: CAPTAIN_DISCORD_ID,
        rosterManageMemberIds: [CAPTAIN_MEMBER_ID],
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.status).toBe('declined');
            expect(result.request_id).toBe(JOIN_REQUEST_PENDING_ID);

            // The join request in store must be updated
            const req = joinRequestsStore.get(JOIN_REQUEST_PENDING_ID);
            expect(req?.status).toBe('declined');

            // tournament_attendance_update must have been emitted with declined status
            const emitted = emittedSyncEvents.filter(
              (e) => e.type === 'tournament_attendance_update',
            ) as EmittedAttendanceUpdateEvent[];
            expect(emitted).toHaveLength(1);
            expect(emitted[0].status).toBe('declined');
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 12: DeclineJoinRequest already decided
// ---------------------------------------------------------------------------

describe('Event/DeclineJoinRequest — already decided', () => {
  itEffect.effect('request already decided → JoinRequestAlreadyDecided', () =>
    callDeclineJoinRequest({
      request_id: JOIN_REQUEST_DECIDED_ID,
      discord_user_id: CAPTAIN_DISCORD_ID,
      rosterManageMemberIds: [CAPTAIN_MEMBER_ID],
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('JoinRequestAlreadyDecided');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 13: GetAttendanceOverview
// ---------------------------------------------------------------------------

describe('Event/GetAttendanceOverview', () => {
  itEffect.effect(
    '2 accepted + 1 pending + 1 declined → accepted.length=2, pending.length=1, declined excluded',
    () => {
      // Add a second accepted entry and one declined entry to the store
      const SECOND_ACCEPTED_ID =
        'cccccccc-cccc-cccc-cccc-cccccccccccc' as EventRpcModels.JoinRequestId;
      const DECLINED_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd' as EventRpcModels.JoinRequestId;

      joinRequestsStore.set(SECOND_ACCEPTED_ID, {
        id: SECOND_ACCEPTED_ID,
        event_id: EVENT_ACTIVE_TOURNAMENT,
        team_member_id: CAPTAIN_MEMBER_ID,
        status: 'accepted',
        member_display_name: Option.some('Captain User'),
        member_discord_id: Option.some(CAPTAIN_DISCORD_ID),
        message: Option.none(),
        discord_channel_id: Option.none(),
        discord_message_id: Option.none(),
        decided_by: Option.some(CAPTAIN_MEMBER_ID),
        decided_by_display_name: Option.some('Captain User'),
      });

      joinRequestsStore.set(DECLINED_ID, {
        id: DECLINED_ID,
        event_id: EVENT_ACTIVE_TOURNAMENT,
        team_member_id: OTHER_MEMBER_MEMBER_ID,
        status: 'declined',
        member_display_name: Option.some('Other Member'),
        member_discord_id: Option.some(OTHER_MEMBER_DISCORD_ID),
        message: Option.none(),
        discord_channel_id: Option.none(),
        discord_message_id: Option.none(),
        decided_by: Option.some(CAPTAIN_MEMBER_ID),
        decided_by_display_name: Option.some('Captain User'),
      });

      return callGetAttendanceOverview({ event_id: EVENT_ACTIVE_TOURNAMENT }).pipe(
        Effect.tap((overview) =>
          Effect.sync(() => {
            // accepted: JOIN_REQUEST_DECIDED_ID (already seeded) + SECOND_ACCEPTED_ID = 2
            expect(overview.accepted).toHaveLength(2);
            // pending: JOIN_REQUEST_PENDING_ID = 1
            expect(overview.pending).toHaveLength(1);
            // declined entries are not included in accepted or pending
            expect(overview.event_id).toBe(EVENT_ACTIVE_TOURNAMENT);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 14: SaveJoinRequestMessageId
// ---------------------------------------------------------------------------

describe('Event/SaveJoinRequestMessageId', () => {
  itEffect.effect(
    'persists channel + message id; subsequent findRequestById reflects discord_channel_id and discord_message_id',
    () => {
      const CHANNEL_ID = '555555555555555555' as Discord.Snowflake;
      const MESSAGE_ID = '666666666666666666' as Discord.Snowflake;

      return callSaveJoinRequestMessageId({
        request_id: JOIN_REQUEST_PENDING_ID,
        channel_id: CHANNEL_ID,
        message_id: MESSAGE_ID,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // The mock repository should have updated the record
            const req = joinRequestsStore.get(JOIN_REQUEST_PENDING_ID);
            expect(req).toBeDefined();
            if (req) {
              // B2: discord_channel_id must also be persisted
              expect(Option.isSome(req.discord_channel_id)).toBe(true);
              if (Option.isSome(req.discord_channel_id)) {
                expect(req.discord_channel_id.value).toBe(CHANNEL_ID);
              }
              expect(Option.isSome(req.discord_message_id)).toBe(true);
              if (Option.isSome(req.discord_message_id)) {
                expect(req.discord_message_id.value).toBe(MESSAGE_ID);
              }
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 15: B4 — decline-then-resubmit reopens to pending and emits
// ---------------------------------------------------------------------------

const JOIN_REQUEST_DECLINED_ID =
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' as EventRpcModels.JoinRequestId;

describe('Event/SubmitJoinRequest — decline-then-resubmit (B4)', () => {
  itEffect.effect(
    'declined member re-applies → row reopened to pending, created=true, sync event emitted',
    () => {
      // Pre-seed a declined request for CAPTAIN_MEMBER_ID
      joinRequestsStore.set(JOIN_REQUEST_DECLINED_ID, {
        id: JOIN_REQUEST_DECLINED_ID,
        event_id: EVENT_ACTIVE_TOURNAMENT,
        team_member_id: CAPTAIN_MEMBER_ID,
        status: 'declined',
        member_display_name: Option.some('Captain User'),
        member_discord_id: Option.some(CAPTAIN_DISCORD_ID),
        message: Option.none(),
        discord_channel_id: Option.none(),
        discord_message_id: Option.none(),
        decided_by: Option.some(CAPTAIN_MEMBER_ID),
        decided_by_display_name: Option.none(),
      });

      return callSubmitJoinRequest({
        event_id: EVENT_ACTIVE_TOURNAMENT,
        discord_user_id: CAPTAIN_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Row reopened to pending
            expect(result.status).toBe('pending');
            expect(result.created).toBe(true);
            expect(result.request_id).toBe(JOIN_REQUEST_DECLINED_ID);

            // Store reflects the reopen
            const req = joinRequestsStore.get(JOIN_REQUEST_DECLINED_ID);
            expect(req?.status).toBe('pending');
            expect(Option.isNone(req?.decided_by ?? Option.none())).toBe(true);

            // sync event must be emitted (review message needs to be re-posted)
            const emitted = emittedSyncEvents.filter(
              (e) => e.type === 'tournament_join_request' && e.eventId === EVENT_ACTIVE_TOURNAMENT,
            );
            expect(emitted).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 16: B4 — already-accepted member resubmits → no-op, created=false, no emit
// ---------------------------------------------------------------------------

describe('Event/SubmitJoinRequest — accepted member resubmits (B4)', () => {
  itEffect.effect(
    'accepted member resubmits → row unchanged, created=false, no sync event emitted',
    () => {
      // OTHER_MEMBER_MEMBER_ID has an accepted request (JOIN_REQUEST_DECIDED_ID)
      return callSubmitJoinRequest({
        event_id: EVENT_ACTIVE_TOURNAMENT,
        discord_user_id: OTHER_MEMBER_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.status).toBe('accepted');
            expect(result.created).toBe(false);
            expect(result.request_id).toBe(JOIN_REQUEST_DECIDED_ID);

            // no sync event emitted
            const emitted = emittedSyncEvents.filter((e) => e.type === 'tournament_join_request');
            expect(emitted).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 17: B3 — cross-team forgery: request_id belongs to a different team
// ---------------------------------------------------------------------------

const FOREIGN_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const FOREIGN_EVENT_ID = '00000000-0000-0000-0000-000000000064' as Event.EventId;
const FOREIGN_REQUEST_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff' as EventRpcModels.JoinRequestId;

describe('Event/AcceptJoinRequest — B3 cross-team forgery', () => {
  itEffect.effect(
    'request_id from a different team → JoinRequestAlreadyDecided (not accepted)',
    () => {
      // Seed a foreign event belonging to a different team
      eventsStore.set(FOREIGN_EVENT_ID, {
        ...eventsStore.get(EVENT_ACTIVE_TOURNAMENT)!,
        id: FOREIGN_EVENT_ID,
        team_id: FOREIGN_TEAM_ID,
      });
      // Seed a pending request on the foreign event
      joinRequestsStore.set(FOREIGN_REQUEST_ID, {
        id: FOREIGN_REQUEST_ID,
        event_id: FOREIGN_EVENT_ID,
        team_member_id: MEMBER_MEMBER_ID,
        status: 'pending',
        member_display_name: Option.some('Member User'),
        member_discord_id: Option.some(MEMBER_DISCORD_ID),
        message: Option.none(),
        discord_channel_id: Option.none(),
        discord_message_id: Option.none(),
        decided_by: Option.none(),
        decided_by_display_name: Option.none(),
      });

      // Captain from TEAM_ID tries to accept a request from FOREIGN_TEAM_ID's event
      return callAcceptJoinRequest({
        request_id: FOREIGN_REQUEST_ID,
        team_id: TEAM_ID, // captain's own team
        discord_user_id: CAPTAIN_DISCORD_ID,
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              // B3: mock returns None (team mismatch) → JoinRequestAlreadyDecided
              const err = result.failure as any;
              expect(err._tag).toBe('JoinRequestAlreadyDecided');
            }
            // The foreign request must remain pending (not accepted)
            const req = joinRequestsStore.get(FOREIGN_REQUEST_ID);
            expect(req?.status).toBe('pending');
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
