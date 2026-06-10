// NOTE: These tests are written in TDD mode BEFORE the implementation of the
// Event/ClaimTraining and Event/UnclaimTraining RPC handlers.
// They reference new repository methods (claimTraining, unclaimTraining,
// emitTrainingClaimUpdate, findClaimInfo) that do not yet exist.
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
const COACH_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const OTHER_COACH_DISCORD_ID = '222222222222222222' as Discord.Snowflake;
const NON_COACH_DISCORD_ID = '333333333333333333' as Discord.Snowflake;
const COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const OTHER_COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const NON_COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;

const EVENT_ACTIVE_TRAINING = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const EVENT_ACTIVE_MATCH = '00000000-0000-0000-0000-000000000061' as Event.EventId;
const EVENT_CANCELLED = '00000000-0000-0000-0000-000000000062' as Event.EventId;
const EVENT_STARTED = '00000000-0000-0000-0000-000000000063' as Event.EventId;
const EVENT_NO_OWNER_GROUP = '00000000-0000-0000-0000-000000000064' as Event.EventId;
const EVENT_ALREADY_CLAIMED = '00000000-0000-0000-0000-000000000065' as Event.EventId;
const BOGUS_EVENT_ID = '99999999-9999-9999-9999-999999999999' as Event.EventId;

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
  // Other fields that EventWithDetails needs
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

// Track emitted sync events for assertion
type EmittedSyncEvent = {
  type: string;
  eventId: Event.EventId;
  claimedByMemberId: Option.Option<TeamMember.TeamMemberId>;
  claimedByDisplayName: Option.Option<string>;
};
let emittedSyncEvents: EmittedSyncEvent[];

// Track claim update calls
type ClaimCall = {
  eventId: Event.EventId;
  memberId: TeamMember.TeamMemberId;
};
let claimCalls: ClaimCall[];
let unclaimCalls: ClaimCall[];

// After claiming, this controls what `findClaimInfo` returns
let claimInfoOverride: Map<Event.EventId, EventRpcModels.EventClaimInfo | null>;

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
  emittedSyncEvents = [];
  claimCalls = [];
  unclaimCalls = [];
  claimInfoOverride = new Map();

  // Active training — unclaimed — owner_group_id set
  eventsStore.set(
    EVENT_ACTIVE_TRAINING,
    makeBaseEvent(EVENT_ACTIVE_TRAINING, {
      title: 'Active Training',
      owner_group_id: Option.some(OWNER_GROUP_ID),
      claimed_by: Option.none(),
    }),
  );

  // Active match — not a training
  eventsStore.set(
    EVENT_ACTIVE_MATCH,
    makeBaseEvent(EVENT_ACTIVE_MATCH, {
      event_type: 'match',
      title: 'Active Match',
      owner_group_id: Option.some(OWNER_GROUP_ID),
    }),
  );

  // Cancelled training
  eventsStore.set(
    EVENT_CANCELLED,
    makeBaseEvent(EVENT_CANCELLED, {
      status: 'cancelled',
      title: 'Cancelled Training',
      owner_group_id: Option.some(OWNER_GROUP_ID),
    }),
  );

  // Started training
  eventsStore.set(
    EVENT_STARTED,
    makeBaseEvent(EVENT_STARTED, {
      status: 'started',
      title: 'Started Training',
      owner_group_id: Option.some(OWNER_GROUP_ID),
    }),
  );

  // Active training — no owner_group_id
  eventsStore.set(
    EVENT_NO_OWNER_GROUP,
    makeBaseEvent(EVENT_NO_OWNER_GROUP, {
      title: 'Training without owner group',
      owner_group_id: Option.none(),
    }),
  );

  // Active training — already claimed by OTHER_COACH_MEMBER_ID
  eventsStore.set(
    EVENT_ALREADY_CLAIMED,
    makeBaseEvent(EVENT_ALREADY_CLAIMED, {
      title: 'Already Claimed Training',
      owner_group_id: Option.some(OWNER_GROUP_ID),
      claimed_by: Option.some(OTHER_COACH_MEMBER_ID),
      claimer_name: Option.some('Other Coach'),
    }),
  );
};

// ---------------------------------------------------------------------------
// Mock SQL layer (for member lookup by discord_id)
// ---------------------------------------------------------------------------

// The RPC handler uses raw SQL to look up team_member_id by (discord_user_id, team_id).
// We return the correct member row based on which discord_id is in the query.
const makeMockSqlClientLayer = () =>
  Layer.succeed(
    SqlClient.SqlClient,
    Object.assign(
      function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
        // Inspect args to determine which discord_id is being looked up
        const discordId = _args.find(
          (a) => typeof a === 'string' && /^\d{17,20}$/.test(a as string),
        );
        if (discordId === COACH_DISCORD_ID) {
          return Effect.succeed([
            {
              id: COACH_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Coach User',
              username: null,
            },
          ]);
        }
        if (discordId === OTHER_COACH_DISCORD_ID) {
          return Effect.succeed([
            {
              id: OTHER_COACH_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Other Coach',
              username: null,
            },
          ]);
        }
        if (discordId === NON_COACH_DISCORD_ID) {
          return Effect.succeed([
            {
              id: NON_COACH_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Player',
              username: null,
            },
          ]);
        }
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
// Mock repository layers
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
    // New methods added by the implementation:
    claimTraining: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
      claimCalls.push({ eventId, memberId });
      const ev = eventsStore.get(eventId);
      if (!ev) return Effect.succeed(Option.none());
      if (Option.isSome(ev.claimed_by)) return Effect.succeed(Option.none()); // already claimed
      eventsStore.set(eventId, { ...ev, claimed_by: Option.some(memberId) });
      return Effect.succeed(Option.some({ id: eventId }));
    },
    unclaimTraining: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
      unclaimCalls.push({ eventId, memberId });
      const ev = eventsStore.get(eventId);
      if (!ev) return Effect.succeed(Option.none());
      const currentClaimer = ev.claimed_by;
      if (Option.isNone(currentClaimer) || currentClaimer.value !== memberId) {
        return Effect.succeed(Option.none());
      }
      eventsStore.set(eventId, { ...ev, claimed_by: Option.none() });
      return Effect.succeed(Option.some({ id: eventId }));
    },
    findClaimInfo: (eventId: Event.EventId) => {
      const override = claimInfoOverride.get(eventId);
      if (override !== undefined)
        return Effect.succeed(override ? Option.some(override) : Option.none());
      const ev = eventsStore.get(eventId);
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
    saveClaimDiscordMessage: () => Effect.void,
  } as any);

const makeMockGroupsRepository = (coachMemberIds: TeamMember.TeamMemberId[]) =>
  Layer.succeed(GroupsRepository, {
    getDescendantMemberIds: (_groupId: GroupModel.GroupId) => Effect.succeed(coachMemberIds),
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
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    // New emit methods added by the implementation:
    emitTrainingClaimUpdate: (
      _teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _startAt: unknown,
      _endAt: unknown,
      _location: unknown,
      _description: unknown,
      _claimDiscordChannelId: unknown,
      _claimDiscordMessageId: unknown,
      claimedByMemberId: Option.Option<TeamMember.TeamMemberId>,
      claimedByDisplayName: Option.Option<string>,
      _eventStatus: string,
    ) => {
      emittedSyncEvents.push({
        type: 'training_claim_update',
        eventId,
        claimedByMemberId,
        claimedByDisplayName,
      });
      return Effect.void;
    },
    emitTrainingClaimRequest: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
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

const buildRpcTestLayer = (
  coachMemberIds: TeamMember.TeamMemberId[] = [COACH_MEMBER_ID, OTHER_COACH_MEMBER_ID],
) =>
  EventsRpcLive.pipe(
    Layer.provide(makeMockEventsRepository()),
    Layer.provide(makeMockGroupsRepository(coachMemberIds)),
    Layer.provide(makeMockSyncEventsRepository()),
    Layer.provide(makeMockTeamMembersRepository()),
    Layer.provide(makeMockTeamSettingsRepository()),
    Layer.provide(makeMockTeamsRepository()),
    Layer.provide(makeMockTrainingTypesRepository()),
    Layer.provide(makeMockEventRsvpsRepository()),
    Layer.provide(makeMockDiscordChannelMappingRepository()),
    Layer.provide(makeMockChannelEventDividersRepository()),
    Layer.provide(makeMockSqlClientLayer()),
    Layer.provide(MockEventRostersRepositoryLayer),
    Layer.provide(MockEventRosterRequestsRepositoryLayer),
    Layer.provide(MockEventRosterProvisioningServiceLayer),
  );

// Helper to call Event/ClaimTraining via RPC
const callClaimTraining = (params: {
  event_id: Event.EventId;
  team_id?: Team.TeamId;
  discord_user_id: Discord.Snowflake;
  coachMemberIds?: TeamMember.TeamMemberId[];
}) => {
  const layer = buildRpcTestLayer(params.coachMemberIds);
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/ClaimTraining']({
            event_id: params.event_id,
            team_id: params.team_id ?? TEAM_ID,
            discord_user_id: params.discord_user_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

// Helper to call Event/UnclaimTraining via RPC
const callUnclaimTraining = (params: {
  event_id: Event.EventId;
  team_id?: Team.TeamId;
  discord_user_id: Discord.Snowflake;
  coachMemberIds?: TeamMember.TeamMemberId[];
}) => {
  const layer = buildRpcTestLayer(params.coachMemberIds);
  return Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/UnclaimTraining']({
            event_id: params.event_id,
            team_id: params.team_id ?? TEAM_ID,
            discord_user_id: params.discord_user_id,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Case 1: Claim happy path
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — happy path', () => {
  itEffect.effect(
    'coach claims unclaimed active training — returns EventClaimInfo with claimed_by set',
    () =>
      callClaimTraining({
        event_id: EVENT_ACTIVE_TRAINING,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // claimed_by_member_id must be Some(COACH_MEMBER_ID)
            expect(Option.isSome(result.claimed_by_member_id)).toBe(true);
            if (Option.isSome(result.claimed_by_member_id)) {
              expect(result.claimed_by_member_id.value).toBe(COACH_MEMBER_ID);
            }
            // Event in store must have claimed_by set
            const ev = eventsStore.get(EVENT_ACTIVE_TRAINING);
            expect(ev).toBeDefined();
            if (ev !== undefined) {
              expect(Option.isSome(ev.claimed_by)).toBe(true);
            }
            // A training_claim_update sync event must have been emitted
            const emitted = emittedSyncEvents.filter(
              (e) => e.type === 'training_claim_update' && e.eventId === EVENT_ACTIVE_TRAINING,
            );
            expect(emitted).toHaveLength(1);
            expect(Option.isSome(emitted[0].claimedByMemberId)).toBe(true);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 2: Claim race / already claimed
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — already claimed', () => {
  itEffect.effect(
    'returns ClaimAlreadyClaimed when event is already claimed by another coach',
    () =>
      callClaimTraining({
        event_id: EVENT_ALREADY_CLAIMED,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              const err = result.failure as any;
              expect(err._tag).toBe('ClaimAlreadyClaimed');
            }
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// Case 3: Claim non-coach (not in owner_group descendants)
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — non-coach caller', () => {
  itEffect.effect('returns ClaimNotOwnerGroupMember when caller is not in owner group', () =>
    callClaimTraining({
      event_id: EVENT_ACTIVE_TRAINING,
      discord_user_id: NON_COACH_DISCORD_ID,
      // Only COACH_MEMBER_ID and OTHER_COACH_MEMBER_ID are in the owner group
      coachMemberIds: [COACH_MEMBER_ID, OTHER_COACH_MEMBER_ID],
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimNotOwnerGroupMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 4: Claim non-training event
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — non-training event', () => {
  itEffect.effect('returns ClaimNotTraining for a match event', () =>
    callClaimTraining({
      event_id: EVENT_ACTIVE_MATCH,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimNotTraining');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 5: Claim cancelled or started event
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — inactive event', () => {
  itEffect.effect('returns ClaimEventInactive for a cancelled event', () =>
    callClaimTraining({
      event_id: EVENT_CANCELLED,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimEventInactive');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('returns ClaimEventInactive for a started event', () =>
    callClaimTraining({
      event_id: EVENT_STARTED,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimEventInactive');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 6: Claim non-existent event
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — event not found', () => {
  itEffect.effect('returns ClaimEventNotFound for a bogus event_id', () =>
    callClaimTraining({
      event_id: BOGUS_EVENT_ID,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimEventNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 7: Claim with owner_group_id IS NULL
// ---------------------------------------------------------------------------

describe('Event/ClaimTraining — no owner group', () => {
  itEffect.effect('returns ClaimNotOwnerGroupMember when owner_group_id is NULL', () =>
    callClaimTraining({
      event_id: EVENT_NO_OWNER_GROUP,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('ClaimNotOwnerGroupMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Case 8: Unclaim happy path
// ---------------------------------------------------------------------------

describe('Event/UnclaimTraining — happy path', () => {
  itEffect.effect('current claimer successfully unclaims — DB shows claimed_by IS NULL', () => {
    // Pre-claim the event
    eventsStore.set(
      EVENT_ACTIVE_TRAINING,
      makeBaseEvent(EVENT_ACTIVE_TRAINING, {
        claimed_by: Option.some(COACH_MEMBER_ID),
        owner_group_id: Option.some(OWNER_GROUP_ID),
      }),
    );

    return callUnclaimTraining({
      event_id: EVENT_ACTIVE_TRAINING,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // claimed_by_member_id must be None
          expect(Option.isNone(result.claimed_by_member_id)).toBe(true);
          // Event in store must have cleared claimed_by
          const ev = eventsStore.get(EVENT_ACTIVE_TRAINING);
          expect(ev).toBeDefined();
          if (ev !== undefined) {
            expect(Option.isNone(ev.claimed_by)).toBe(true);
          }
          // A training_claim_update sync event with None claimed_by must be emitted
          const emitted = emittedSyncEvents.filter(
            (e) => e.type === 'training_claim_update' && e.eventId === EVENT_ACTIVE_TRAINING,
          );
          expect(emitted).toHaveLength(1);
          expect(Option.isNone(emitted[0].claimedByMemberId)).toBe(true);
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Case 9: Unclaim by non-claimer
// ---------------------------------------------------------------------------

describe('Event/UnclaimTraining — not the claimer', () => {
  itEffect.effect(
    'returns ClaimNotClaimer when caller is in owner group but is not the claimer',
    () => {
      // OTHER_COACH_MEMBER_ID is the claimer, COACH_DISCORD_ID maps to COACH_MEMBER_ID
      eventsStore.set(
        EVENT_ACTIVE_TRAINING,
        makeBaseEvent(EVENT_ACTIVE_TRAINING, {
          claimed_by: Option.some(OTHER_COACH_MEMBER_ID),
          owner_group_id: Option.some(OWNER_GROUP_ID),
        }),
      );

      return callUnclaimTraining({
        event_id: EVENT_ACTIVE_TRAINING,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              const err = result.failure as any;
              expect(err._tag).toBe('ClaimNotClaimer');
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
