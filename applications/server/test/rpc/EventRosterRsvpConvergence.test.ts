// NOTE: TDD mode — tests will FAIL until EventRosterProvisioningService is
// wired into both the Event/SubmitRsvp RPC handler and the HTTP PUT rsvp handler.
// Expected: provisioning service called with correct args on yes and on withdraw.
// Provisioning failure must NOT fail the RSVP write.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, TeamMember } from '@sideline/domain';
import { EventRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
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

const RPC_TEAM_ID = '00000000-0000-0000-0000-000000000010' as any;
const RPC_EVENT_ID = '00000000-0000-0000-0000-000000000070' as Event.EventId;
const RPC_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const RPC_DISCORD_USER_ID = '123456789012345678' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Recorded provisioning calls
// ---------------------------------------------------------------------------

type ProvisioningCall = {
  type: 'onRsvp';
  newResponse: string;
  priorResponse: Option.Option<string>;
  memberId: TeamMember.TeamMemberId;
};

let provisioningCalls: ProvisioningCall[];
let provisioningFailure: boolean;

const resetProvisioningCalls = () => {
  provisioningCalls = [];
  provisioningFailure = false;
};

// ---------------------------------------------------------------------------
// Mock provisioning service
// ---------------------------------------------------------------------------

const MockEventRosterProvisioningServiceLayer = Layer.succeed(EventRosterProvisioningService, {
  onRsvp: (params: {
    teamId: any;
    event: any;
    memberId: TeamMember.TeamMemberId;
    discordUserId: any;
    priorResponse: Option.Option<string>;
    newResponse: string;
    displayName: any;
  }) => {
    if (provisioningFailure) {
      return Effect.fail(new Error('provisioning failed deliberately'));
    }
    provisioningCalls.push({
      type: 'onRsvp',
      newResponse: params.newResponse,
      priorResponse: params.priorResponse,
      memberId: params.memberId,
    });
    return Effect.void;
  },
  approve: () => Effect.die(new Error('approve not expected in these tests')),
  decline: () => Effect.die(new Error('decline not expected in these tests')),
  backfill: () => Effect.die(new Error('backfill not expected in these tests')),
} as any);

// ---------------------------------------------------------------------------
// Minimal event + rsvp stores
// ---------------------------------------------------------------------------

let rsvpStore: Map<string, { response: string; priorResponse: Option.Option<string> }>;

const resetRsvpStore = () => {
  rsvpStore = new Map();
};

const MockRpcEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findByIdWithDetails: (id: Event.EventId) =>
    Effect.succeed(
      id === RPC_EVENT_ID
        ? Option.some({
            id: RPC_EVENT_ID,
            team_id: RPC_TEAM_ID,
            training_type_id: Option.none(),
            event_type: 'tournament',
            title: 'Test Tournament',
            description: Option.none(),
            start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
            end_at: Option.none(),
            location: Option.none(),
            status: 'active',
            created_by: RPC_MEMBER_ID,
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
          })
        : Option.none(),
    ),
  findEventByIdWithDetails: (id: Event.EventId) =>
    Effect.succeed(
      id === RPC_EVENT_ID
        ? Option.some({
            id: RPC_EVENT_ID,
            team_id: RPC_TEAM_ID,
            training_type_id: Option.none(),
            event_type: 'tournament',
            title: 'Test Tournament',
            description: Option.none(),
            start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
            end_at: Option.none(),
            location: Option.none(),
            status: 'active',
            created_by: RPC_MEMBER_ID,
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
          })
        : Option.none(),
    ),
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  insert: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  markReminderSent: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findEventsByChannelId: () => Effect.succeed([]),
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findNonResponders: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.none()),
  markEventPersonalMessagesDirty: () => Effect.void,
} as any);

const MockRpcEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: string,
    _message: any,
    _clearMessage: any,
  ) => {
    const key = `${eventId}:${memberId}`;
    const existing = rsvpStore.get(key);
    const priorResponse = existing ? Option.some(existing.response) : Option.none<string>();
    rsvpStore.set(key, { response, priorResponse });
    return Effect.succeed({
      row: {
        id: 'rsvp-1',
        event_id: eventId,
        team_member_id: memberId,
        response,
        message: Option.none(),
      },
      priorResponse,
    });
  },
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
  findNonResponders: () => Effect.succeed([]),
  findNonRespondersByEventId: () => Effect.succeed([]),
  findRsvpAttendeesPage: () => Effect.succeed([]),
  countRsvpTotal: () => Effect.succeed(0),
  findYesAttendeesForEmbed: () => Effect.succeed([]),
} as any);

const MockRpcTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  addMember: () => Effect.die(new Error('Not implemented')),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  resetMissedRsvps: () => Effect.void,
} as any);

const MockRpcGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
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
  getDescendantMemberIds: () => Effect.succeed([]),
} as any);

const MockRpcTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: () => Effect.succeed(Option.none()),
  findByGuildId: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockRpcTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
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

const MockRpcChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

const MockRpcDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
} as any);

const MockRpcEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockRpcTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
  findEventsForReminder: () => Effect.succeed([]),
  findEventsNeedingReminder: () => Effect.succeed([]),
  findLateRsvpChannelId: () => Effect.succeed(Option.none()),
} as any);

// Mock SQL layer
const MOCK_MEMBER_LOOKUP_ROW = {
  id: RPC_MEMBER_ID,
  name: null,
  nickname: null,
  display_name: null,
  username: null,
};

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([MOCK_MEMBER_LOOKUP_ROW]);
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
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) =>
        Effect.succeed([MOCK_MEMBER_LOOKUP_ROW]),
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

const MockEventRostersRepositoryLayer = Layer.succeed(EventRostersRepository, {
  findByEventId: () => Effect.succeed(Option.none()),
  link: () => Effect.die(new Error('Not implemented')),
  unlink: () => Effect.void,
  setAutoApprove: () => Effect.void,
  saveThreadIfAbsent: () => Effect.succeed(Option.none()),
  clearThread: () => Effect.void,
} as any);

const MockEventRosterRequestsRepositoryLayer = Layer.succeed(EventRosterRequestsRepository, {
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsertApproved: () => Effect.die(new Error('Not implemented')),
  upsertPending: () => Effect.die(new Error('Not implemented')),
  claimDecision: () => Effect.succeed(Option.none()),
  cancel: () => Effect.succeed(Option.none()),
  saveMessageId: () => Effect.void,
  findPendingByEvent: () => Effect.succeed([]),
  findPendingByRoster: () => Effect.succeed([]),
  wasMemberBefore: () => Effect.succeed(false),
  findById: () => Effect.succeed(Option.none()),
} as any);

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(MockRpcEventsRepositoryLayer),
  Layer.provide(MockRpcEventRsvpsRepositoryLayer),
  Layer.provide(MockRpcTeamSettingsRepositoryLayer),
  Layer.provide(MockRpcEventSyncEventsRepositoryLayer),
  Layer.provide(MockRpcTeamMembersRepositoryLayer),
  Layer.provide(MockRpcGroupsRepositoryLayer),
  Layer.provide(MockRpcTeamsRepositoryLayer),
  Layer.provide(MockRpcTrainingTypesRepositoryLayer),
  Layer.provide(MockRpcChannelEventDividersRepositoryLayer),
  Layer.provide(MockRpcDiscordChannelMappingRepositoryLayer),
  Layer.provide(MockSqlClientLayer),
  Layer.provide(MockEventRosterProvisioningServiceLayer),
  Layer.provide(MockEventRostersRepositoryLayer),
  Layer.provide(MockEventRosterRequestsRepositoryLayer),
);

// Helper to call Event/SubmitRsvp via RPC
const submitRsvp = (
  response: string,
): Effect.Effect<
  unknown,
  unknown,
  typeof RpcTestLayer extends Layer.Layer<infer A, any, any> ? A : never
> =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/SubmitRsvp']({
            event_id: RPC_EVENT_ID,
            team_id: RPC_TEAM_ID,
            discord_user_id: RPC_DISCORD_USER_ID,
            response,
            message: Option.none(),
            clearMessage: false,
          }) as Effect.Effect<unknown, unknown, never>,
      ),
    ),
  );

describe('Event/SubmitRsvp RPC — provisioning service convergence', () => {
  beforeEach(() => {
    resetProvisioningCalls();
    resetRsvpStore();
  });

  itEffect.effect('onRsvp called with correct memberId and newResponse=yes', () =>
    submitRsvp('yes').pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(provisioningCalls).toHaveLength(1);
          expect(provisioningCalls[0].newResponse).toBe('yes');
          expect(provisioningCalls[0].memberId).toBe(RPC_MEMBER_ID);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );

  itEffect.effect('onRsvp called with priorResponse=Some(yes) when withdrawing', () => {
    // Pre-populate a yes RSVP
    rsvpStore.set(`${RPC_EVENT_ID}:${RPC_MEMBER_ID}`, {
      response: 'yes',
      priorResponse: Option.none(),
    });

    return submitRsvp('no').pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(provisioningCalls).toHaveLength(1);
          expect(provisioningCalls[0].newResponse).toBe('no');
          expect(Option.isSome(provisioningCalls[0].priorResponse)).toBe(true);
          if (Option.isSome(provisioningCalls[0].priorResponse)) {
            expect(provisioningCalls[0].priorResponse.value).toBe('yes');
          }
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect('provisioning failure does NOT fail the RSVP write', () => {
    provisioningFailure = true;

    return submitRsvp('yes').pipe(
      // Should succeed (no error) even though provisioning fails
      Effect.tap((result) =>
        Effect.sync(() => {
          // The RSVP write succeeded — result is defined
          expect(result).toBeDefined();
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });
});
