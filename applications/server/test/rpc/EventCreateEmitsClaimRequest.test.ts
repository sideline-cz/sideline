// NOTE: TDD mode — tests reference emitTrainingClaimRequest which does not yet exist.
// The Event/CreateEvent handler currently only emits event_created.
// These tests WILL FAIL until the developer extends CreateEvent to also emit
// training_claim_request when creating a training with an owner group that resolves
// to a Discord channel.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember, TrainingType } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels } from '@sideline/domain';
import { type DateTime, Effect, Layer, Option } from 'effect';
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
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const CREATOR_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const CREATOR_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const OWNER_CHANNEL_ID = '444444444444444444' as Discord.Snowflake;
const OWNER_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const TRAINING_TYPE_ID = '00000000-0000-0000-0000-000000000050' as TrainingType.TrainingTypeId;
const NEW_EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

type EmittedClaimRequest = {
  teamId: Team.TeamId;
  eventId: Event.EventId;
  discordTargetChannelId: Discord.Snowflake;
  discordRoleId: Option.Option<Discord.Snowflake>;
  locationUrl: Option.Option<string>;
};

let emittedEventCreated: Event.EventId[];
let emittedClaimRequests: EmittedClaimRequest[];

// Controls whether the owner group has a Discord channel mapping
let ownerGroupChannelMapping: Option.Option<{
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
}>;

const resetStores = () => {
  emittedEventCreated = [];
  emittedClaimRequests = [];
  ownerGroupChannelMapping = Option.some({
    discord_channel_id: Option.some(OWNER_CHANNEL_ID),
    discord_role_id: Option.some(OWNER_ROLE_ID),
  });
};

// ---------------------------------------------------------------------------
// Mock SQL layer
// ---------------------------------------------------------------------------

// The handler uses raw SQL to:
// 1. Look up team by guild_id
// 2. Look up team_member by (discord_user_id, team_id)
const makeMockSqlClientLayer = () =>
  Layer.succeed(
    SqlClient.SqlClient,
    Object.assign(
      function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
        const sql = _strings.join('?').toLowerCase();
        if (sql.includes('from teams') && sql.includes('guild_id')) {
          return Effect.succeed([{ id: TEAM_ID }]);
        }
        if (sql.includes('from team_members') || sql.includes('join users')) {
          return Effect.succeed([
            {
              id: CREATOR_MEMBER_ID,
              team_member_id: CREATOR_MEMBER_ID,
              name: null,
              nickname: null,
              display_name: 'Creator',
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
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamMembersRepository = () =>
  Layer.succeed(TeamMembersRepository, {
    findMembershipByIds: (_teamId: Team.TeamId, _userId: string) =>
      Effect.succeed(
        Option.some({
          id: CREATOR_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-creator',
          active: true,
          role_names: ['Admin'],
          permissions: ['event:create'] as string[],
        }),
      ),
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

const makeMockEventsRepository = (
  ownerGroupId: Option.Option<GroupModel.GroupId> = Option.some(OWNER_GROUP_ID),
) =>
  Layer.succeed(EventsRepository, {
    insertEvent: (input: {
      teamId: Team.TeamId;
      trainingTypeId: Option.Option<string>;
      eventType: Event.EventType;
      title: string;
      description: Option.Option<string>;
      startAt: DateTime.Utc;
      endAt: Option.Option<DateTime.Utc>;
      location: Option.Option<string>;
      locationUrl: Option.Option<string>;
      createdBy: TeamMember.TeamMemberId;
    }) =>
      Effect.succeed({
        id: NEW_EVENT_ID,
        team_id: TEAM_ID,
        event_type: input.eventType,
        title: input.title,
        description: input.description,
        start_at: input.startAt,
        end_at: input.endAt,
        location: input.location,
        location_url: input.locationUrl,
        status: 'active' as Event.EventStatus,
        created_by: input.createdBy,
        training_type_id: input.trainingTypeId,
        series_id: Option.none(),
        series_modified: false,
        discord_target_channel_id: Option.none(),
        owner_group_id: ownerGroupId,
        member_group_id: Option.none(),
      }),
    findEventByIdWithDetails: () => Effect.succeed(Option.none()),
    findEventsByTeamId: () => Effect.succeed([]),
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

const makeMockSyncEventsRepository = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitEventCreated: (_teamId: Team.TeamId, eventId: Event.EventId) => {
      emittedEventCreated.push(eventId);
      return Effect.void;
    },
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitEventStarted: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    // New method for claim request
    emitTrainingClaimRequest: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _startAt: unknown,
      _endAt: unknown,
      _location: unknown,
      _description: unknown,
      discordTargetChannelId: Discord.Snowflake,
      discordRoleId: Option.Option<Discord.Snowflake>,
      locationUrl: Option.Option<string>,
    ) => {
      emittedClaimRequests.push({
        teamId,
        eventId,
        discordTargetChannelId,
        discordRoleId,
        locationUrl,
      });
      return Effect.void;
    },
    emitTrainingClaimUpdate: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
  } as any);

const makeMockTrainingTypesRepository = (
  ownerGroupId: Option.Option<GroupModel.GroupId> = Option.some(OWNER_GROUP_ID),
) =>
  Layer.succeed(TrainingTypesRepository, {
    findByTeamId: () => Effect.succeed([]),
    findTrainingTypesByTeamId: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    findTrainingTypeById: (id: TrainingType.TrainingTypeId) => {
      if (id === TRAINING_TYPE_ID) {
        return Effect.succeed(
          Option.some({
            id: TRAINING_TYPE_ID,
            team_id: TEAM_ID,
            name: 'Fitness Training',
            discord_channel_id: Option.none<Discord.Snowflake>(),
          }),
        );
      }
      return Effect.succeed(Option.none());
    },
    findByIdWithGroup: () => Effect.succeed(Option.none()),
    findTrainingTypeByIdWithGroup: (id: TrainingType.TrainingTypeId) => {
      if (id === TRAINING_TYPE_ID) {
        return Effect.succeed(
          Option.some({
            id: TRAINING_TYPE_ID,
            team_id: TEAM_ID,
            name: 'Fitness Training',
            owner_group_id: ownerGroupId,
            discord_channel_id: Option.none<Discord.Snowflake>(),
          }),
        );
      }
      return Effect.succeed(Option.none());
    },
    insert: () => Effect.die(new Error('Not implemented')),
    insertTrainingType: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    updateTrainingType: () => Effect.die(new Error('Not implemented')),
    deleteTrainingType: () => Effect.void,
    deleteTrainingTypeById: () => Effect.void,
  } as any);

const makeMockDiscordChannelMappingRepository = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: (_teamId: Team.TeamId, groupId: GroupModel.GroupId) => {
      if (groupId === OWNER_GROUP_ID) {
        return Effect.succeed(ownerGroupChannelMapping);
      }
      return Effect.succeed(Option.none());
    },
    insert: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    findAllByTeamId: () => Effect.succeed([]),
    findAllByTeam: () => Effect.succeed([]),
  } as any);

const makeStaticLayers = () =>
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
    Layer.succeed(ChannelEventDividersRepository, {
      findByChannelId: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      deleteByChannelId: () => Effect.void,
    } as any),
  );

// Build the full RPC test layer with owner-group channel mapping
const buildRpcTestLayer = (
  ownerGroupId: Option.Option<GroupModel.GroupId> = Option.some(OWNER_GROUP_ID),
) =>
  EventsRpcLive.pipe(
    Layer.provide(makeMockEventsRepository(ownerGroupId)),
    Layer.provide(makeMockSyncEventsRepository()),
    Layer.provide(makeMockTeamMembersRepository()),
    Layer.provide(makeMockTrainingTypesRepository(ownerGroupId)),
    Layer.provide(makeMockDiscordChannelMappingRepository()),
    Layer.provide(makeStaticLayers()),
    Layer.provide(makeMockSqlClientLayer()),
  );

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Case 12: Creating a training with owner_group_id resolving to an owners channel
//          emits training_claim_request
// ---------------------------------------------------------------------------

describe('Event/CreateEvent — training_claim_request emission', () => {
  itEffect.effect(
    'emits training_claim_request when creating a training with owner-group channel',
    () =>
      Effect.scoped(
        (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
          Effect.flatMap(
            (rpc: any) =>
              rpc['Event/CreateEvent']({
                guild_id: GUILD_ID,
                discord_user_id: CREATOR_DISCORD_ID,
                event_type: 'training' as Event.EventType,
                title: 'New Training',
                start_at: '2099-12-31 18:00',
                end_at: Option.none<string>(),
                location: Option.none<string>(),
                location_url: Option.none<string>(),
                description: Option.none<string>(),
                training_type_id: Option.some(TRAINING_TYPE_ID),
              }) as Effect.Effect<EventRpcModels.CreateEventResult, unknown, never>,
          ),
        ),
      ).pipe(
        Effect.tap((_result) =>
          Effect.sync(() => {
            // The training_claim_request must have been emitted
            expect(emittedClaimRequests).toHaveLength(1);
            expect(emittedClaimRequests[0].eventId).toBe(NEW_EVENT_ID);
            expect(emittedClaimRequests[0].discordTargetChannelId).toBe(OWNER_CHANNEL_ID);
          }),
        ),
        Effect.provide(buildRpcTestLayer()),
        Effect.asVoid,
      ),
  );

  // ---------------------------------------------------------------------------
  // Case 13: Creating a non-training event does NOT emit training_claim_request
  // ---------------------------------------------------------------------------

  itEffect.effect('does NOT emit training_claim_request when creating a match event', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/CreateEvent']({
              guild_id: GUILD_ID,
              discord_user_id: CREATOR_DISCORD_ID,
              event_type: 'match' as Event.EventType,
              title: 'New Match',
              start_at: '2099-12-31 18:00',
              end_at: Option.none<string>(),
              location: Option.none<string>(),
              location_url: Option.none<string>(),
              description: Option.none<string>(),
              training_type_id: Option.none<TrainingType.TrainingTypeId>(),
            }) as Effect.Effect<EventRpcModels.CreateEventResult, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((_result) =>
        Effect.sync(() => {
          expect(emittedClaimRequests).toHaveLength(0);
          // event_created must still have been emitted
          expect(emittedEventCreated).toHaveLength(1);
        }),
      ),
      Effect.provide(buildRpcTestLayer(Option.none())),
      Effect.asVoid,
    ),
  );

  // ---------------------------------------------------------------------------
  // Case 14: Creating a training with no owner_group_id does NOT emit training_claim_request
  // ---------------------------------------------------------------------------

  itEffect.effect('does NOT emit training_claim_request when training has no owner_group_id', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/CreateEvent']({
              guild_id: GUILD_ID,
              discord_user_id: CREATOR_DISCORD_ID,
              event_type: 'training' as Event.EventType,
              title: 'New Training No Owner Group',
              start_at: '2099-12-31 18:00',
              end_at: Option.none<string>(),
              location: Option.none<string>(),
              location_url: Option.none<string>(),
              description: Option.none<string>(),
              training_type_id: Option.none<TrainingType.TrainingTypeId>(),
            }) as Effect.Effect<EventRpcModels.CreateEventResult, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((_result) =>
        Effect.sync(() => {
          // No training_claim_request: training type has no owner group
          expect(emittedClaimRequests).toHaveLength(0);
        }),
      ),
      // Provide layer where training type has no owner_group
      Effect.provide(buildRpcTestLayer(Option.none())),
      Effect.asVoid,
    ),
  );

  itEffect.effect('captures locationUrl in emitted training_claim_request', () =>
    Effect.scoped(
      (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Event/CreateEvent']({
              guild_id: GUILD_ID,
              discord_user_id: CREATOR_DISCORD_ID,
              event_type: 'training' as Event.EventType,
              title: 'Training With Location URL',
              start_at: '2099-12-31 18:00',
              end_at: Option.none<string>(),
              location: Option.some('Main Field'),
              location_url: Option.some('https://maps.google.com/x'),
              description: Option.none<string>(),
              training_type_id: Option.some(TRAINING_TYPE_ID),
            }) as Effect.Effect<EventRpcModels.CreateEventResult, unknown, never>,
        ),
      ),
    ).pipe(
      Effect.tap((_result) =>
        Effect.sync(() => {
          expect(emittedClaimRequests).toHaveLength(1);
          expect(emittedClaimRequests[0].eventId).toBe(NEW_EVENT_ID);
          expect(emittedClaimRequests[0].locationUrl).toEqual(
            Option.some('https://maps.google.com/x'),
          );
        }),
      ),
      Effect.provide(buildRpcTestLayer()),
      Effect.asVoid,
    ),
  );

  itEffect.effect(
    'does NOT emit training_claim_request when owner-group has no Discord channel mapping',
    () => {
      // Clear the owner-group channel mapping
      ownerGroupChannelMapping = Option.none();

      return Effect.scoped(
        (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
          Effect.flatMap(
            (rpc: any) =>
              rpc['Event/CreateEvent']({
                guild_id: GUILD_ID,
                discord_user_id: CREATOR_DISCORD_ID,
                event_type: 'training' as Event.EventType,
                title: 'Training — No Channel',
                start_at: '2099-12-31 18:00',
                end_at: Option.none<string>(),
                location: Option.none<string>(),
                location_url: Option.none<string>(),
                description: Option.none<string>(),
                training_type_id: Option.some(TRAINING_TYPE_ID),
              }) as Effect.Effect<EventRpcModels.CreateEventResult, unknown, never>,
          ),
        ),
      ).pipe(
        Effect.tap((_result) =>
          Effect.sync(() => {
            expect(emittedClaimRequests).toHaveLength(0);
          }),
        ),
        Effect.provide(buildRpcTestLayer()),
        Effect.asVoid,
      );
    },
  );
});
