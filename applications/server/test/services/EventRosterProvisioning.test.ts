// NOTE: TDD mode — tests are written BEFORE the implementation.
// They will FAIL until EventRosterProvisioningService,
// EventRostersRepository, and EventRosterRequestsRepository are implemented.
// That is expected.

import { describe, expect, it } from '@effect/vitest';
import type {
  Discord,
  Event,
  EventRosterModel,
  GroupModel,
  RosterModel,
  Team,
  TeamMember,
} from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;
const DECIDER_MEMBER_ID = '00000000-0000-0000-0000-000000000099' as TeamMember.TeamMemberId;
const OWNER_CHANNEL_ID = '222222222222222222' as Discord.Snowflake;
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000040' as GroupModel.GroupId;
const MEMBER_GROUP_ID = '00000000-0000-0000-0000-000000000041' as GroupModel.GroupId;
const EVENT_ROSTER_ID = 'event-roster-001' as EventRosterModel.EventRosterId;
const REQUEST_ID = 'request-001' as EventRosterModel.EventRosterRequestId;

// ---------------------------------------------------------------------------
// Helper type for collected side-effects
// ---------------------------------------------------------------------------

type Calls = {
  rosterMemberAdded: Array<{
    rosterId: RosterModel.RosterId;
    teamMemberId: TeamMember.TeamMemberId;
  }>;
  rosterMemberRemoved: Array<{
    rosterId: RosterModel.RosterId;
    teamMemberId: TeamMember.TeamMemberId;
  }>;
  approvalRequestEmitted: Array<{ eventId: Event.EventId; memberId: TeamMember.TeamMemberId }>;
  approvalCancelEmitted: Array<{ eventId: Event.EventId }>;
  addedToRoster: Array<{ rosterId: RosterModel.RosterId; memberId: TeamMember.TeamMemberId }>;
  removedFromRoster: Array<{ rosterId: RosterModel.RosterId; memberId: TeamMember.TeamMemberId }>;
};

const makeCalls = (): Calls => ({
  rosterMemberAdded: [],
  rosterMemberRemoved: [],
  approvalRequestEmitted: [],
  approvalCancelEmitted: [],
  addedToRoster: [],
  removedFromRoster: [],
});

// ---------------------------------------------------------------------------
// Base event fixture
// ---------------------------------------------------------------------------

const baseEventRecord = {
  id: EVENT_ID,
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  event_type: 'tournament' as Event.EventType,
  title: 'Summer Tournament',
  start_at: new Date('2099-07-01T10:00:00Z'),
  owner_group_id: Option.some(OWNER_GROUP_ID),
  member_group_id: Option.some(MEMBER_GROUP_ID),
};

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

const makeEventRostersRepository = (
  opts: {
    autoApprove?: boolean;
    ownerThreadId?: Option.Option<Discord.Snowflake>;
    ownerChannelId?: Option.Option<Discord.Snowflake>;
    rosterName?: string;
    memberGroupId?: Option.Option<GroupModel.GroupId>;
  } = {},
): Layer.Layer<EventRostersRepository> => {
  const {
    autoApprove = false,
    ownerThreadId = Option.none(),
    ownerChannelId = Option.some(OWNER_CHANNEL_ID),
    rosterName = 'Tournament Squad',
    memberGroupId = Option.some(MEMBER_GROUP_ID),
  } = opts;

  return Layer.succeed(EventRostersRepository, {
    findByEventId: (_eventId: Event.EventId) =>
      Effect.succeed(
        Option.some({
          id: EVENT_ROSTER_ID,
          event_id: EVENT_ID,
          roster_id: ROSTER_ID,
          auto_approve: autoApprove,
          owners_thread_id: ownerThreadId,
          owner_channel_id: ownerChannelId,
          roster_name: rosterName,
          member_group_id: memberGroupId,
        }),
      ),
    link: () => Effect.die(new Error('link not expected')),
    unlink: () => Effect.void,
    setAutoApprove: () => Effect.void,
    saveThreadIfAbsent: () => Effect.succeed(ownerThreadId),
    clearThread: () => Effect.void,
  } as any);
};

const makeEventRostersRepositoryNone = (): Layer.Layer<EventRostersRepository> =>
  Layer.succeed(EventRostersRepository, {
    findByEventId: () => Effect.succeed(Option.none()),
    link: () => Effect.die(new Error('link not expected')),
    unlink: () => Effect.void,
    setAutoApprove: () => Effect.void,
    saveThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearThread: () => Effect.void,
  } as any);

const makeRequestsRepository = (
  opts: {
    existingRequest?: Option.Option<{
      id: EventRosterModel.EventRosterRequestId;
      status: EventRosterModel.EventRosterRequestStatus;
      was_member_before: boolean;
      discord_message_id: Option.Option<Discord.Snowflake>;
    }>;
    claimDecisionResult?: Option.Option<{ was_member_before: boolean }>;
    cancelResult?: Option.Option<{
      status: EventRosterModel.EventRosterRequestStatus;
      was_member_before: boolean;
    }>;
    pendingByEvent?: Array<{
      team_member_id: TeamMember.TeamMemberId;
      discord_id: Option.Option<Discord.Snowflake>;
      display_name: Option.Option<string>;
      discord_message_id: Option.Option<Discord.Snowflake>;
    }>;
  } = {},
) => {
  const {
    existingRequest = Option.none(),
    claimDecisionResult = Option.some({ was_member_before: false }),
    cancelResult = Option.none(),
    pendingByEvent = [],
  } = opts;

  return Layer.succeed(EventRosterRequestsRepository, {
    findByEventAndMember: () => Effect.succeed(existingRequest),
    upsertApproved: (_eventId: any, _rosterId: any, _memberId: any, wasMember: boolean) =>
      Effect.succeed({
        id: REQUEST_ID,
        status: 'approved' as EventRosterModel.EventRosterRequestStatus,
        was_member_before: wasMember,
      }),
    upsertPending: () =>
      Effect.succeed({
        id: REQUEST_ID,
        status: 'pending' as EventRosterModel.EventRosterRequestStatus,
        was_member_before: false,
      }),
    claimDecision: () => Effect.succeed(claimDecisionResult),
    cancel: () => Effect.succeed(cancelResult),
    saveMessageId: () => Effect.void,
    findPendingByEvent: () => Effect.succeed(pendingByEvent),
    wasMemberBefore: () => Effect.succeed(false),
    findPendingByRoster: () => Effect.succeed([]),
  } as any);
};

const makeRostersRepository = (opts: { isMember?: boolean; rosterName?: string } = {}) => {
  const { isMember = false, rosterName = 'Tournament Squad' } = opts;

  return Layer.succeed(RostersRepository, {
    findRosterById: (_rosterId: RosterModel.RosterId) =>
      Effect.succeed(
        Option.some({
          id: ROSTER_ID,
          name: rosterName,
          team_id: TEAM_ID,
          active: true,
        }),
      ),
    findByTeamId: () => Effect.succeed([]),
    findMemberEntriesById: (_rosterId: RosterModel.RosterId) =>
      Effect.succeed(
        isMember ? [{ team_member_id: MEMBER_ID, discord_user_id: DISCORD_USER_ID }] : [],
      ),
    addMemberById: (_rosterId: RosterModel.RosterId, _memberId: TeamMember.TeamMemberId) =>
      Effect.void,
    removeMemberById: (_rosterId: RosterModel.RosterId, _memberId: TeamMember.TeamMemberId) =>
      Effect.void,
    insert: () => Effect.die(new Error('insert not expected')),
    update: () => Effect.die(new Error('update not expected')),
    delete: () => Effect.void,
  } as any);
};

const makeChannelSyncEventsRepository = (calls: Calls): Layer.Layer<ChannelSyncEventsRepository> =>
  Layer.succeed(ChannelSyncEventsRepository, {
    emitRosterMemberAdded: (
      _teamId: any,
      rosterId: RosterModel.RosterId,
      _rosterName: any,
      teamMemberId: TeamMember.TeamMemberId,
      _discordUserId: any,
    ) => {
      calls.rosterMemberAdded.push({ rosterId, teamMemberId });
      return Effect.void;
    },
    emitRosterMemberRemoved: (
      _teamId: any,
      rosterId: RosterModel.RosterId,
      _rosterName: any,
      teamMemberId: TeamMember.TeamMemberId,
      _discordUserId: any,
    ) => {
      calls.rosterMemberRemoved.push({ rosterId, teamMemberId });
      return Effect.void;
    },
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

const makeEventSyncEventsRepository = (calls: Calls): Layer.Layer<EventSyncEventsRepository> =>
  Layer.succeed(EventSyncEventsRepository, {
    emitEventRosterApprovalRequest: (
      _teamId: any,
      eventId: Event.EventId,
      _eventRosterId: any,
      _rosterId: any,
      memberId: TeamMember.TeamMemberId,
      _candidateDisplayName: any,
      _title: any,
      _startAt: any,
      _ownersThreadId: any,
      _ownerChannelId: any,
      _rosterName: any,
    ) => {
      calls.approvalRequestEmitted.push({ eventId, memberId });
      return Effect.void;
    },
    emitEventRosterApprovalCancel: (
      _teamId: any,
      eventId: Event.EventId,
      _ownersThreadId: any,
      _discordMessageId: any,
    ) => {
      calls.approvalCancelEmitted.push({ eventId });
      return Effect.void;
    },
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitEventStarted: () => Effect.void,
    emitTrainingClaimRequest: () => Effect.void,
    emitTrainingClaimUpdate: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
    emitCoachingStatus: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeGroupsRepository = (
  opts: { isInOwnerGroup?: boolean; memberGroupMembers?: string[] } = {},
) => {
  const { isInOwnerGroup = true, memberGroupMembers = [MEMBER_ID] } = opts;

  return Layer.succeed(GroupsRepository, {
    findGroupsByTeamId: () => Effect.succeed([]),
    findGroupById: () => Effect.succeed(Option.none()),
    insertGroup: () => Effect.die(new Error('not expected')),
    updateGroupById: () => Effect.die(new Error('not expected')),
    archiveGroupById: () => Effect.void,
    moveGroup: () => Effect.die(new Error('not expected')),
    findMembersByGroupId: () => Effect.succeed([]),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
    getRolesForGroup: () => Effect.succeed([]),
    getMemberCount: () => Effect.succeed(0),
    getChildren: () => Effect.succeed([]),
    getAncestorIds: () => Effect.succeed([]),
    getDescendantMemberIds: (groupId: GroupModel.GroupId) => {
      if (groupId === MEMBER_GROUP_ID) return Effect.succeed(memberGroupMembers);
      // For owner group membership checks: return the decided-by snowflake cast as member id
      return Effect.succeed(
        isInOwnerGroup ? ([DISCORD_USER_ID] as unknown as TeamMember.TeamMemberId[]) : [],
      );
    },
  } as any);
};

// ---------------------------------------------------------------------------
// Mock TeamMembersRepository — returns the test member's RosterEntry so that
// addMemberToRoster can resolve a real discord_id from the team member record.
// ---------------------------------------------------------------------------

const makeTeamMembersRepository = (): Layer.Layer<TeamMembersRepository> =>
  Layer.succeed(TeamMembersRepository, {
    findRosterMemberByIds: (_teamId: any, memberId: any) =>
      Effect.succeed(
        memberId === MEMBER_ID
          ? Option.some({
              member_id: MEMBER_ID,
              user_id: '00000000-0000-0000-0000-000000000001',
              discord_id: DISCORD_USER_ID,
              role_names: [],
              permissions: [],
              name: Option.none(),
              birth_date: Option.none(),
              gender: Option.none(),
              jersey_number: Option.none(),
              username: 'testuser',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            })
          : Option.none(),
      ),
    addMember: () => Effect.die(new Error('addMember not expected')),
    findById: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findTeamMembersWithNames: () => Effect.succeed([]),
    findMembershipByIds: () => Effect.succeed(Option.none()),
    findMembershipByDiscordAndTeam: () => Effect.succeed(Option.none()),
    deactivateMemberByIds: () => Effect.die(new Error('deactivateMemberByIds not expected')),
    reactivateMember: () => Effect.die(new Error('reactivateMember not expected')),
    getPlayerRoleId: () => Effect.succeed(Option.none()),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
    hardDelete: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Build the test layer
// ---------------------------------------------------------------------------

const buildTestLayer = (
  eventRostersLayer: Layer.Layer<EventRostersRepository>,
  requestsLayer: Layer.Layer<EventRosterRequestsRepository>,
  rostersLayer: Layer.Layer<RostersRepository>,
  channelSyncLayer: Layer.Layer<ChannelSyncEventsRepository>,
  eventSyncLayer: Layer.Layer<EventSyncEventsRepository>,
  groupsLayer: Layer.Layer<GroupsRepository>,
) =>
  EventRosterProvisioningService.Default.pipe(
    Layer.provide(eventRostersLayer),
    Layer.provide(requestsLayer),
    Layer.provide(rostersLayer),
    Layer.provide(channelSyncLayer),
    Layer.provide(eventSyncLayer),
    Layer.provide(groupsLayer),
    Layer.provide(makeTeamMembersRepository()),
  );

// ---------------------------------------------------------------------------
// Tests — T1: yes + autoON, not member → approved/auto + addMemberById + emitRosterMemberAdded
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — onRsvp', () => {
  it.effect(
    'T1: yes + autoON + not member → request approved, addMember, emitRosterMemberAdded once',
    () => {
      const calls = makeCalls();

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.onRsvp({
            teamId: TEAM_ID,
            event: baseEventRecord as any,
            memberId: MEMBER_ID,
            discordUserId: Option.some(DISCORD_USER_ID),
            priorResponse: Option.none(),
            newResponse: 'yes',
            displayName: Option.some('Alice'),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(calls.rosterMemberAdded).toHaveLength(1);
            expect(calls.rosterMemberAdded[0].rosterId).toBe(ROSTER_ID);
            expect(calls.approvalRequestEmitted).toHaveLength(0);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: true }),
            makeRequestsRepository(),
            makeRostersRepository({ isMember: false }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository(),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T1b: yes + autoON + already member (was_member_before=true) → request recorded but no duplicate addMember emit',
    () => {
      const calls = makeCalls();

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.onRsvp({
            teamId: TEAM_ID,
            event: baseEventRecord as any,
            memberId: MEMBER_ID,
            discordUserId: Option.some(DISCORD_USER_ID),
            priorResponse: Option.none(),
            newResponse: 'yes',
            displayName: Option.some('Alice'),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // Already a member: no second emit
            expect(calls.rosterMemberAdded).toHaveLength(0);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: true }),
            makeRequestsRepository(),
            makeRostersRepository({ isMember: true }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository(),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T2: yes + autoOFF + ownerGroup → request pending, emitApprovalRequest once, no roster add',
    () => {
      const calls = makeCalls();

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.onRsvp({
            teamId: TEAM_ID,
            event: baseEventRecord as any,
            memberId: MEMBER_ID,
            discordUserId: Option.some(DISCORD_USER_ID),
            priorResponse: Option.none(),
            newResponse: 'yes',
            displayName: Option.some('Alice'),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(calls.approvalRequestEmitted).toHaveLength(1);
            expect(calls.approvalRequestEmitted[0].memberId).toBe(MEMBER_ID);
            expect(calls.rosterMemberAdded).toHaveLength(0);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: false }),
            makeRequestsRepository(),
            makeRostersRepository({ isMember: false }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository({ isInOwnerGroup: true }),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('T3: yes + autoOFF + NO ownerGroup → no request, no emit, no throw', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: { ...baseEventRecord, owner_group_id: Option.none() } as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.none(),
          newResponse: 'yes',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.approvalRequestEmitted).toHaveLength(0);
          expect(calls.rosterMemberAdded).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository(),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('T4: duplicate yes, already approved → no second emit/add', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.some('yes'),
          newResponse: 'yes',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.rosterMemberAdded).toHaveLength(0);
          expect(calls.approvalRequestEmitted).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: true }),
          makeRequestsRepository({
            existingRequest: Option.some({
              id: REQUEST_ID,
              status: 'approved',
              was_member_before: false,
              discord_message_id: Option.none(),
            }),
          }),
          makeRostersRepository({ isMember: true }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('T5: duplicate yes, already pending → no second emit', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.some('yes'),
          newResponse: 'yes',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.approvalRequestEmitted).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            existingRequest: Option.some({
              id: REQUEST_ID,
              status: 'pending',
              was_member_before: false,
              discord_message_id: Option.none(),
            }),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('T8: withdraw + pending → cancel → emitApprovalCancel, NO removeMember', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.some('yes'),
          newResponse: 'no',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.approvalCancelEmitted).toHaveLength(1);
          expect(calls.rosterMemberRemoved).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            existingRequest: Option.some({
              id: REQUEST_ID,
              status: 'pending',
              was_member_before: false,
              discord_message_id: Option.some('msg-001' as Discord.Snowflake),
            }),
            cancelResult: Option.some({ status: 'pending', was_member_before: false }),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect(
    'T9: withdraw + approved + was_member_before=false → removeMember + emitRosterMemberRemoved',
    () => {
      const calls = makeCalls();

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.onRsvp({
            teamId: TEAM_ID,
            event: baseEventRecord as any,
            memberId: MEMBER_ID,
            discordUserId: Option.some(DISCORD_USER_ID),
            priorResponse: Option.some('yes'),
            newResponse: 'no',
            displayName: Option.some('Alice'),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(calls.rosterMemberRemoved).toHaveLength(1);
            expect(calls.rosterMemberRemoved[0].rosterId).toBe(ROSTER_ID);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: true }),
            makeRequestsRepository({
              existingRequest: Option.some({
                id: REQUEST_ID,
                status: 'approved',
                was_member_before: false,
                discord_message_id: Option.none(),
              }),
              cancelResult: Option.some({ status: 'approved', was_member_before: false }),
            }),
            makeRostersRepository({ isMember: true }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository(),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T10: withdraw + was_member_before=true → removeMemberById NOT called (provenance protection)',
    () => {
      const calls = makeCalls();

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.onRsvp({
            teamId: TEAM_ID,
            event: baseEventRecord as any,
            memberId: MEMBER_ID,
            discordUserId: Option.some(DISCORD_USER_ID),
            priorResponse: Option.some('yes'),
            newResponse: 'no',
            displayName: Option.some('Alice'),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // was_member_before=true → we must NOT remove them from the roster
            expect(calls.rosterMemberRemoved).toHaveLength(0);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: true }),
            makeRequestsRepository({
              existingRequest: Option.some({
                id: REQUEST_ID,
                status: 'approved',
                was_member_before: true,
                discord_message_id: Option.none(),
              }),
              cancelResult: Option.some({ status: 'approved', was_member_before: true }),
            }),
            makeRostersRepository({ isMember: true }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository(),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('T10b: withdraw + no request row → removeMemberById NOT called', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.some('yes'),
          newResponse: 'no',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.rosterMemberRemoved).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: true }),
          makeRequestsRepository({
            existingRequest: Option.none(),
            cancelResult: Option.none(),
          }),
          makeRostersRepository({ isMember: true }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('T11: re-RSVP yes after declined → reopens (emitApprovalRequest for autoOFF)', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.none(),
          newResponse: 'yes',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.approvalRequestEmitted).toHaveLength(1);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            existingRequest: Option.some({
              id: REQUEST_ID,
              status: 'declined',
              was_member_before: false,
              discord_message_id: Option.none(),
            }),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('no linked roster → onRsvp is a no-op', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.onRsvp({
          teamId: TEAM_ID,
          event: baseEventRecord as any,
          memberId: MEMBER_ID,
          discordUserId: Option.some(DISCORD_USER_ID),
          priorResponse: Option.none(),
          newResponse: 'yes',
          displayName: Option.some('Alice'),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.rosterMemberAdded).toHaveLength(0);
          expect(calls.approvalRequestEmitted).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepositoryNone(),
          makeRequestsRepository(),
          makeRostersRepository(),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// T6: approve (guarded) → member added
// T7: decline → no add
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — approve / decline', () => {
  it.effect('T6: approve → member added, gated on returned row from claimDecision', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.approve({
          eventId: EVENT_ID,
          teamId: TEAM_ID,
          memberId: MEMBER_ID,
          deciderMemberId: DECIDER_MEMBER_ID,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.rosterMemberAdded).toHaveLength(1);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            claimDecisionResult: Option.some({ was_member_before: false }),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('T7: decline → no roster add', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.decline({
          eventId: EVENT_ID,
          teamId: TEAM_ID,
          memberId: MEMBER_ID,
          deciderMemberId: DECIDER_MEMBER_ID,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.rosterMemberAdded).toHaveLength(0);
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            claimDecisionResult: Option.some({ was_member_before: false }),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect(
    'approve does NOT check owner-group (auth is caller responsibility) — always proceeds',
    () => {
      const calls = makeCalls();
      // The service no longer performs owner-group checks (B1 fix): that responsibility
      // belongs to the RPC handler (discord) or HTTP handler (roster:manage).
      // Verify the service succeeds regardless of isInOwnerGroup.
      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.approve({
            eventId: EVENT_ID,
            teamId: TEAM_ID,
            memberId: MEMBER_ID,
            deciderMemberId: DECIDER_MEMBER_ID,
          }),
        ),
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Success');
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: false }),
            makeRequestsRepository({
              claimDecisionResult: Option.some({ was_member_before: false }),
            }),
            makeRostersRepository({ isMember: false }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository({ isInOwnerGroup: false }),
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('approve when request not pending → RosterRequestNotPending error', () => {
    const calls = makeCalls();

    return Effect.Do.pipe(
      Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
      Effect.flatMap(({ service }) =>
        service.approve({
          eventId: EVENT_ID,
          teamId: TEAM_ID,
          memberId: MEMBER_ID,
          deciderMemberId: DECIDER_MEMBER_ID,
        }),
      ),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(JSON.stringify(result.failure)).toContain('RosterRequestNotPending');
          }
        }),
      ),
      Effect.provide(
        buildTestLayer(
          makeEventRostersRepository({ autoApprove: false }),
          makeRequestsRepository({
            // claimDecision returns None → request was not pending (already handled)
            claimDecisionResult: Option.none(),
          }),
          makeRostersRepository({ isMember: false }),
          makeChannelSyncEventsRepository(calls),
          makeEventSyncEventsRepository(calls),
          makeGroupsRepository({ isInOwnerGroup: true }),
        ),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// S7: was_member_before immutability
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — was_member_before provenance (S7)', () => {
  it.effect(
    'approve: was_member_before=true when member already on roster → T10 protects them on withdraw',
    () => {
      const calls = makeCalls();

      // Member is already on the roster at approve time
      const requestsLayer = makeRequestsRepository({
        // claimDecision returns was_member_before=true (as set at first upsert)
        claimDecisionResult: Option.some({ was_member_before: true }),
      });

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.approve({
            eventId: EVENT_ID,
            teamId: TEAM_ID,
            memberId: MEMBER_ID,
            deciderMemberId: DECIDER_MEMBER_ID,
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // Member was already on roster so must NOT be re-added
            expect(calls.rosterMemberAdded).toHaveLength(0);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: false }),
            requestsLayer,
            makeRostersRepository({ isMember: true }),
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            makeGroupsRepository(),
          ),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// S7b: full provenance sequence — flow-add → withdraw → MANUAL add → re-RSVP yes → withdraw
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — S7b provenance sequence', () => {
  it.effect(
    'flow-add → withdraw → MANUAL add → re-RSVP yes → withdraw: final withdraw does NOT remove member',
    () => {
      // Stateful roster mock: reflects roster membership changes in real time
      const rosterMembers = new Set<TeamMember.TeamMemberId>();

      // Stateful requests mock: tracks the current approved row
      let currentRequestRow: Option.Option<{
        status: EventRosterModel.EventRosterRequestStatus;
        was_member_before: boolean;
      }> = Option.none();

      const removedFromRoster: Array<TeamMember.TeamMemberId> = [];

      const rostersLayer = Layer.succeed(RostersRepository, {
        findRosterById: () =>
          Effect.succeed(
            Option.some({
              id: ROSTER_ID,
              name: 'Tournament Squad',
              team_id: TEAM_ID,
              active: true,
            }),
          ),
        findByTeamId: () => Effect.succeed([]),
        findMemberEntriesById: (_rosterId: RosterModel.RosterId) =>
          Effect.succeed(
            rosterMembers.has(MEMBER_ID)
              ? [{ team_member_id: MEMBER_ID, discord_user_id: DISCORD_USER_ID }]
              : [],
          ),
        addMemberById: (_rosterId: RosterModel.RosterId, memberId: TeamMember.TeamMemberId) => {
          rosterMembers.add(memberId);
          return Effect.void;
        },
        removeMemberById: (_rosterId: RosterModel.RosterId, memberId: TeamMember.TeamMemberId) => {
          rosterMembers.delete(memberId);
          removedFromRoster.push(memberId);
          return Effect.void;
        },
        insert: () => Effect.die(new Error('not expected')),
        update: () => Effect.die(new Error('not expected')),
        delete: () => Effect.void,
      } as any);

      const requestsLayer = Layer.succeed(EventRosterRequestsRepository, {
        findByEventAndMember: () => Effect.succeed(Option.none()),
        upsertApproved: (
          _eventId: Event.EventId,
          _rosterId: RosterModel.RosterId,
          _memberId: TeamMember.TeamMemberId,
          wasMember: boolean,
        ) => {
          currentRequestRow = Option.some({
            status: 'approved' as EventRosterModel.EventRosterRequestStatus,
            was_member_before: wasMember,
          });
          return Effect.succeed({
            id: REQUEST_ID,
            status: 'approved' as EventRosterModel.EventRosterRequestStatus,
            was_member_before: wasMember,
          });
        },
        upsertPending: () =>
          Effect.succeed({
            id: REQUEST_ID,
            status: 'pending' as EventRosterModel.EventRosterRequestStatus,
            was_member_before: false,
          }),
        claimDecision: () => Effect.succeed(Option.some({ was_member_before: false })),
        cancel: () => {
          const prior = currentRequestRow;
          currentRequestRow = Option.none();
          return Effect.succeed(prior);
        },
        saveMessageId: () => Effect.void,
        findPendingByEvent: () => Effect.succeed([]),
        wasMemberBefore: () => Effect.succeed(false),
        findPendingByRoster: () => Effect.succeed([]),
      } as any);

      const calls = makeCalls();

      const layer = buildTestLayer(
        makeEventRostersRepository({ autoApprove: true }),
        requestsLayer,
        rostersLayer,
        makeChannelSyncEventsRepository(calls),
        makeEventSyncEventsRepository(calls),
        makeGroupsRepository(),
      );

      const rsvpParams = (newResponse: string, priorResponse: Option.Option<string>) => ({
        teamId: TEAM_ID,
        event: baseEventRecord as any,
        memberId: MEMBER_ID,
        discordUserId: Option.some(DISCORD_USER_ID),
        priorResponse,
        newResponse,
        displayName: Option.some('Alice'),
      });

      return Effect.Do.pipe(
        Effect.bind('svc', () => EventRosterProvisioningService.asEffect()),
        // Step 1: flow-add (RSVP yes, not on roster) → added with was_member_before=false
        Effect.tap(({ svc }) => svc.onRsvp(rsvpParams('yes', Option.none()))),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(rosterMembers.has(MEMBER_ID)).toBe(true);
          }),
        ),
        // Step 2: withdraw → removed (was_member_before=false)
        Effect.tap(({ svc }) => svc.onRsvp(rsvpParams('no', Option.some('yes')))),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(rosterMembers.has(MEMBER_ID)).toBe(false);
            expect(removedFromRoster).toHaveLength(1);
          }),
        ),
        // Step 3: MANUAL add (simulate captain manually adding them to roster)
        Effect.tap(() =>
          Effect.sync(() => {
            rosterMembers.add(MEMBER_ID);
          }),
        ),
        // Step 4: re-RSVP yes — member IS on roster now → wasMemberBefore=true, no add emit
        Effect.tap(({ svc }) => svc.onRsvp(rsvpParams('yes', Option.none()))),
        Effect.tap(() =>
          Effect.sync(() => {
            // Only one rosterMemberAdded emit: from step 1; step 4 is no-op (wasMemberBefore=true)
            expect(calls.rosterMemberAdded).toHaveLength(1);
          }),
        ),
        // Step 5: withdraw again — was_member_before=true → must NOT remove from roster
        Effect.tap(({ svc }) => svc.onRsvp(rsvpParams('no', Option.some('yes')))),
        Effect.tap(() =>
          Effect.sync(() => {
            // removedFromRoster still only has the one from step 2
            expect(removedFromRoster).toHaveLength(1);
            // Member remains on roster (was manually added)
            expect(rosterMembers.has(MEMBER_ID)).toBe(true);
          }),
        ),
        Effect.provide(layer),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T12: backfill
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — backfill (T12)', () => {
  it.effect(
    'T12: fresh+pending yes-responders added; already-member not re-added; outside memberGroup not added',
    () => {
      const calls = makeCalls();

      const FRESH_MEMBER = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
      const ALREADY_MEMBER = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;
      const PENDING_MEMBER = '00000000-0000-0000-0000-000000000024' as TeamMember.TeamMemberId;
      const OUTSIDE_MEMBER = '00000000-0000-0000-0000-000000000025' as TeamMember.TeamMemberId;

      // Only FRESH_MEMBER, ALREADY_MEMBER, PENDING_MEMBER are in member group
      const groupsLayer = makeGroupsRepository({
        memberGroupMembers: [FRESH_MEMBER, ALREADY_MEMBER, PENDING_MEMBER],
      });

      // Roster has ALREADY_MEMBER
      const rostersLayer = Layer.succeed(RostersRepository, {
        findRosterById: () =>
          Effect.succeed(
            Option.some({ id: ROSTER_ID, name: 'Squad', team_id: TEAM_ID, active: true }),
          ),
        findByTeamId: () => Effect.succeed([]),
        findMemberEntriesById: () =>
          Effect.succeed([
            {
              team_member_id: ALREADY_MEMBER,
              discord_user_id: '333333333333333333' as Discord.Snowflake,
            },
          ]),
        addMemberById: (_rosterId: any, memberId: TeamMember.TeamMemberId) => {
          calls.addedToRoster.push({ rosterId: ROSTER_ID, memberId });
          return Effect.void;
        },
        removeMemberById: (_rosterId: any, memberId: TeamMember.TeamMemberId) => {
          calls.removedFromRoster.push({ rosterId: ROSTER_ID, memberId });
          return Effect.void;
        },
        insert: () => Effect.die(new Error('not expected')),
        update: () => Effect.die(new Error('not expected')),
        delete: () => Effect.void,
      } as any);

      // Pending requests for PENDING_MEMBER
      const requestsLayer = Layer.succeed(EventRosterRequestsRepository, {
        findByEventAndMember: (_eventId: any, memberId: TeamMember.TeamMemberId) =>
          Effect.succeed(
            memberId === PENDING_MEMBER
              ? Option.some({
                  id: 'req-pending',
                  status: 'pending',
                  was_member_before: false,
                  discord_message_id: Option.none(),
                })
              : Option.none(),
          ),
        upsertApproved: (_e: any, _r: any, _m: any, _w: any) =>
          Effect.succeed({ id: 'new-req', status: 'approved', was_member_before: false }),
        upsertPending: () =>
          Effect.succeed({ id: 'new-req', status: 'pending', was_member_before: false }),
        claimDecision: () => Effect.succeed(Option.some({ was_member_before: false })),
        cancel: () => Effect.succeed(Option.some({ status: 'pending', was_member_before: false })),
        saveMessageId: () => Effect.void,
        findPendingByEvent: () =>
          Effect.succeed([
            {
              team_member_id: PENDING_MEMBER,
              discord_id: Option.none(),
              display_name: Option.none(),
              discord_message_id: Option.none(),
            },
          ]),
        wasMemberBefore: () => Effect.succeed(false),
        findPendingByRoster: () => Effect.succeed([]),
      } as any);

      // Yes-responders: FRESH_MEMBER, ALREADY_MEMBER, PENDING_MEMBER, OUTSIDE_MEMBER
      const yesResponders = [
        {
          team_member_id: FRESH_MEMBER,
          discord_user_id: Option.some('444' as Discord.Snowflake),
          display_name: Option.some('Fresh'),
        },
        {
          team_member_id: ALREADY_MEMBER,
          discord_user_id: Option.some('555' as Discord.Snowflake),
          display_name: Option.some('Already'),
        },
        {
          team_member_id: PENDING_MEMBER,
          discord_user_id: Option.some('666' as Discord.Snowflake),
          display_name: Option.some('Pending'),
        },
        {
          team_member_id: OUTSIDE_MEMBER,
          discord_user_id: Option.some('777' as Discord.Snowflake),
          display_name: Option.some('Outside'),
        },
      ];

      return Effect.Do.pipe(
        Effect.bind('service', () => EventRosterProvisioningService.asEffect()),
        Effect.flatMap(({ service }) =>
          service.backfill({
            eventId: EVENT_ID,
            teamId: TEAM_ID,
            rosterId: ROSTER_ID,
            yesResponders: yesResponders as any,
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            // fresh member was added
            const addedIds = calls.addedToRoster.map((c) => c.memberId);
            expect(addedIds).toContain(FRESH_MEMBER);
            // pending member was approved and added
            expect(addedIds).toContain(PENDING_MEMBER);
            // already-member was not re-added
            expect(addedIds).not.toContain(ALREADY_MEMBER);
            // outside member-group was NOT added
            expect(addedIds).not.toContain(OUTSIDE_MEMBER);
            // result counts
            expect((result as any).added).toBeGreaterThanOrEqual(2);
          }),
        ),
        Effect.provide(
          buildTestLayer(
            makeEventRostersRepository({ autoApprove: true }),
            requestsLayer,
            rostersLayer,
            makeChannelSyncEventsRepository(calls),
            makeEventSyncEventsRepository(calls),
            groupsLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );
});
