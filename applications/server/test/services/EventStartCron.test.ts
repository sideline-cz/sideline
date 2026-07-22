// NOTE (TDD additions at bottom): new tests reference extended types/signatures.
// Tests at the bottom also cover Change A (coach param / owners-role routing).
// Those additions will FAIL to compile until the developer implements the server task.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { eventStartCronEffect } from '~/services/EventStartCron.js';

// --- Test IDs ---
const EVENT_ID_1 = '00000000-0000-0000-0000-000000000001' as Event.EventId;
const EVENT_ID_2 = '00000000-0000-0000-0000-000000000002' as Event.EventId;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GROUP_ID_A = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000040' as GroupModel.GroupId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000050' as TeamMember.TeamMemberId;
const CHANNEL_OWNER = '222222222222222222' as Discord.Snowflake;
const ROLE_ID = '333333333333333333' as Discord.Snowflake;
const OWNERS_ROLE_ID = '444444444444444444' as Discord.Snowflake;

const START_AT = DateTime.makeUnsafe('2026-04-09T10:00:00Z');
const END_AT = DateTime.makeUnsafe('2026-04-09T12:00:00Z');

// --- In-memory stores ---
type StartableEvent = {
  id: Event.EventId;
  team_id: Team.TeamId;
  title: string;
  description: Option.Option<string>;
  image_url?: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  location_url?: Option.Option<string>;
  event_type: string;
  all_day?: boolean;
  // New fields added by the fix/improve-reminders-feature branch
  member_group_id: Option.Option<GroupModel.GroupId>;
  discord_target_channel_id: Option.Option<Discord.Snowflake>;
  owner_group_id: Option.Option<GroupModel.GroupId>;
  reminders_channel_id: Option.Option<Discord.Snowflake>;
  // Change A: coach claiming
  claimed_by: Option.Option<TeamMember.TeamMemberId>;
};

type StartedEvent = { eventId: Event.EventId };
type EmittedStarted = {
  eventId: Event.EventId;
  teamId: Team.TeamId;
  memberGroupId: Option.Option<GroupModel.GroupId>;
  discordChannelId: Option.Option<Discord.Snowflake>;
  discordRoleId: Option.Option<Discord.Snowflake>;
  // Change A: new trailing param
  claimedByMemberId: Option.Option<TeamMember.TeamMemberId>;
};

type IncrementedNonResponders = {
  eventId: Event.EventId;
  teamId: string;
  memberGroupId: Option.Option<GroupModel.GroupId>;
};

let eventsToStart: StartableEvent[];
let startedEvents: StartedEvent[];
let emittedStarted: EmittedStarted[];
let incrementedNonResponders: IncrementedNonResponders[];
let channelMappings: Map<
  string,
  { discord_channel_id: Discord.Snowflake; discord_role_id: Option.Option<Discord.Snowflake> }
>;
// TDD additions: personal-messages "dirty" bookkeeping (fix/personal-messages-dirty-sweep).
// dirtyMarked tracks per-event markEventPersonalMessagesDirty calls; staleSweepCalls
// tracks the once-per-cron-cycle markStalePersonalMessagesDirty sweep.
let dirtyMarked: Event.EventId[];
let staleSweepCalls = 0;

const resetStores = () => {
  eventsToStart = [];
  startedEvents = [];
  emittedStarted = [];
  incrementedNonResponders = [];
  channelMappings = new Map();
  dirtyMarked = [];
  staleSweepCalls = 0;
};

// --- Mock layers ---

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findEventsToStart: () => Effect.succeed(eventsToStart),
  startEvent: (eventId: Event.EventId) => {
    startedEvents.push({ eventId });
    return Effect.succeed(Option.some({ id: eventId }));
  },
  markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
    dirtyMarked.push(eventId);
    return Effect.void;
  },
  markStalePersonalMessagesDirty: () => {
    staleSweepCalls++;
    return Effect.void;
  },
  // Stubs for unused methods
  findEventsByTeamId: () => Effect.die(new Error('Not implemented')),
  findEventByIdWithDetails: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancelEvent: () => Effect.die(new Error('Not implemented')),
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

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventStarted: (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    _title: string,
    _description: Option.Option<string>,
    _startAt: DateTime.Utc,
    _endAt: Option.Option<DateTime.Utc>,
    _location: Option.Option<string>,
    _eventType: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    memberGroupId: Option.Option<GroupModel.GroupId>,
    discordRoleId: Option.Option<Discord.Snowflake>,
    // New Change A param (optional trailing)
    _imageUrl?: Option.Option<string>,
    _locationUrl?: Option.Option<string>,
    _allDay?: boolean,
    claimedByMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
  ) => {
    emittedStarted.push({
      teamId,
      eventId,
      memberGroupId,
      discordChannelId,
      discordRoleId,
      claimedByMemberId,
    });
    return Effect.void;
  },
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: (teamId: Team.TeamId, groupId: GroupModel.GroupId) => {
    const key = `${teamId}:${groupId}`;
    const mapping = channelMappings.get(key);
    return Effect.succeed(mapping ? Option.some(mapping) : Option.none());
  },
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  findRsvpsByEventId: () => Effect.die(new Error('Not implemented')),
  findRsvpByEventAndMember: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: () => Effect.die(new Error('Not implemented')),
  countRsvpsByEventId: () => Effect.die(new Error('Not implemented')),
  findRsvpAttendeesPage: () => Effect.die(new Error('Not implemented')),
  findNonRespondersByEventId: () => Effect.die(new Error('Not implemented')),
  countRsvpTotal: () => Effect.die(new Error('Not implemented')),
  findYesAttendeesForEmbed: () => Effect.die(new Error('Not implemented')),
  findYesRsvpMemberIdsByEventId: () => Effect.die(new Error('Not implemented')),
  incrementMissedForEventNonRespondersByEventId: (
    eventId: Event.EventId,
    teamId: string,
    memberGroupId: Option.Option<GroupModel.GroupId>,
  ) => {
    incrementedNonResponders.push({ eventId, teamId, memberGroupId });
    return Effect.void;
  },
} as any);

const MockProvideLayer = Layer.mergeAll(
  MockEventsRepositoryLayer,
  MockEventSyncEventsRepositoryLayer,
  MockChannelMappingRepositoryLayer,
  MockEventRsvpsRepositoryLayer,
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

describe('eventStartCronEffect', () => {
  it.effect('marks active events as started and emits sync event', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Saturday Match',
        description: Option.some('Home match'),
        start_at: START_AT,
        end_at: Option.some(END_AT),
        location: Option.some('Stadium'),
        event_type: 'match',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(startedEvents).toHaveLength(1);
          expect(startedEvents[0].eventId).toBe(EVENT_ID_1);
          expect(emittedStarted).toHaveLength(1);
          expect(emittedStarted[0].eventId).toBe(EVENT_ID_1);
          expect(emittedStarted[0].teamId).toBe(TEAM_ID);
          // incrementMissedForEventNonRespondersByEventId IS called when active→started
          expect(incrementedNonResponders).toHaveLength(1);
          expect(incrementedNonResponders[0].eventId).toBe(EVENT_ID_1);
          expect(incrementedNonResponders[0].teamId).toBe(TEAM_ID);
          expect(Option.isNone(incrementedNonResponders[0].memberGroupId)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('does nothing when no events are ready to start', () => {
    eventsToStart = [];

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(startedEvents).toHaveLength(0);
          expect(emittedStarted).toHaveLength(0);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('processes multiple events in sequence', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Morning Training',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'training',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
      {
        id: EVENT_ID_2,
        team_id: TEAM_ID,
        title: 'Afternoon Match',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.some(END_AT),
        location: Option.some('Away Field'),
        event_type: 'match',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(startedEvents).toHaveLength(2);
          expect(startedEvents.map((e) => e.eventId).sort()).toEqual(
            [EVENT_ID_1, EVENT_ID_2].sort(),
          );
          expect(emittedStarted).toHaveLength(2);
          expect(emittedStarted.map((e) => e.eventId).sort()).toEqual(
            [EVENT_ID_1, EVENT_ID_2].sort(),
          );
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('emits sync event after successfully starting the event', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Training',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'training',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];

    // Verify order: startEvent runs first, then emitEventStarted
    const callOrder: string[] = [];

    const OrderTrackingEventsRepo = Layer.succeed(EventsRepository, {
      findEventsToStart: () => Effect.succeed(eventsToStart),
      startEvent: (eventId: Event.EventId) => {
        startedEvents.push({ eventId });
        callOrder.push('startEvent');
        return Effect.succeed(Option.some({ id: eventId }));
      },
      markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
        dirtyMarked.push(eventId);
        return Effect.void;
      },
      markStalePersonalMessagesDirty: () => {
        staleSweepCalls++;
        return Effect.void;
      },
    } as any);

    const OrderTrackingSyncRepo = Layer.succeed(EventSyncEventsRepository, {
      emitEventStarted: (
        teamId: Team.TeamId,
        eventId: Event.EventId,
        _title: string,
        _description: Option.Option<string>,
        _startAt: DateTime.Utc,
        _endAt: Option.Option<DateTime.Utc>,
        _location: Option.Option<string>,
        _eventType: string,
        discordChannelId: Option.Option<Discord.Snowflake>,
        memberGroupId: Option.Option<GroupModel.GroupId>,
        discordRoleId: Option.Option<Discord.Snowflake>,
        _imageUrl?: Option.Option<string>,
        _locationUrl?: Option.Option<string>,
        _allDay?: boolean,
        claimedByMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
      ) => {
        emittedStarted.push({
          teamId,
          eventId,
          memberGroupId,
          discordChannelId,
          discordRoleId,
          claimedByMemberId,
        });
        callOrder.push('emitEventStarted');
        return Effect.void;
      },
    } as any);

    const OrderTrackingLayer = Layer.mergeAll(
      OrderTrackingEventsRepo,
      OrderTrackingSyncRepo,
      MockChannelMappingRepositoryLayer,
      MockEventRsvpsRepositoryLayer,
    );

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(callOrder).toEqual(['startEvent', 'emitEventStarted']);
        }),
      ),
      Effect.provide(OrderTrackingLayer),
      Effect.asVoid,
    );
  });

  // --- New TDD tests for fix/improve-reminders-feature ---

  it.effect(
    'preserves NoSuchElementError catch around startEvent (event gone before start)',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Gone Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const ReturnsNoneRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        // startEvent returns None → triggers NoSuchElementError path
        startEvent: (_eventId: Event.EventId) => Effect.succeed(Option.none()),
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Should not throw — NoSuchElementError is caught and logged
            expect(emittedStarted).toHaveLength(0);
            // incrementMissedForEventNonRespondersByEventId is NOT called when no transition
            expect(incrementedNonResponders).toHaveLength(0);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            ReturnsNoneRepo,
            MockEventSyncEventsRepositoryLayer,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('per-event error isolation: second event still processed when first fails', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Failing Event',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'training',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
      {
        id: EVENT_ID_2,
        team_id: TEAM_ID,
        title: 'Succeeding Event',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'training',
        member_group_id: Option.none(),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];

    const PartiallyFailingEventsRepo = Layer.succeed(EventsRepository, {
      findEventsToStart: () => Effect.succeed(eventsToStart),
      startEvent: (eventId: Event.EventId) => {
        if (eventId === EVENT_ID_1) return Effect.die(new Error('Simulated start failure'));
        startedEvents.push({ eventId });
        return Effect.succeed(Option.some({ id: eventId }));
      },
      markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
        dirtyMarked.push(eventId);
        return Effect.void;
      },
      markStalePersonalMessagesDirty: () => {
        staleSweepCalls++;
        return Effect.void;
      },
    } as any);

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Second event should succeed despite first failing
          expect(startedEvents.some((e) => e.eventId === EVENT_ID_2)).toBe(true);
          expect(emittedStarted.some((e) => e.eventId === EVENT_ID_2)).toBe(true);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          PartiallyFailingEventsRepo,
          MockEventSyncEventsRepositoryLayer,
          MockChannelMappingRepositoryLayer,
          MockEventRsvpsRepositoryLayer,
        ),
      ),
      Effect.asVoid,
    );
  });

  it.effect('emits member_group_id in emitEventStarted', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Group Match',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'match',
        member_group_id: Option.some(GROUP_ID_A),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedStarted).toHaveLength(1);
          expect(Option.isSome(emittedStarted[0].memberGroupId)).toBe(true);
          if (Option.isSome(emittedStarted[0].memberGroupId)) {
            expect(emittedStarted[0].memberGroupId.value).toBe(GROUP_ID_A);
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('resolves discord_role_id from channel mapping for member_group_id', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Group Match With Role',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'match',
        member_group_id: Option.some(GROUP_ID_A),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: CHANNEL_OWNER,
      discord_role_id: Option.some(ROLE_ID),
    });

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedStarted).toHaveLength(1);
          const emitted = emittedStarted[0];
          expect(Option.isSome(emitted.discordRoleId)).toBe(true);
          if (Option.isSome(emitted.discordRoleId)) {
            expect(emitted.discordRoleId.value).toBe(ROLE_ID);
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('emits with None discord_role_id when no mapping exists for member_group_id', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Group No Mapping',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'match',
        member_group_id: Option.some(GROUP_ID_A),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.none(),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];
    // No mapping set in channelMappings

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedStarted).toHaveLength(1);
          expect(Option.isNone(emittedStarted[0].discordRoleId)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  // -------------------------------------------------------------------------
  // incrementMissedForEventNonRespondersByEventId — cron seam assertions
  // -------------------------------------------------------------------------

  it.effect(
    'incrementMissedForEventNonRespondersByEventId called with event member_group_id on active→started',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Group Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(incrementedNonResponders).toHaveLength(1);
            expect(incrementedNonResponders[0].eventId).toBe(EVENT_ID_1);
            expect(incrementedNonResponders[0].teamId).toBe(TEAM_ID);
            expect(Option.isSome(incrementedNonResponders[0].memberGroupId)).toBe(true);
            if (Option.isSome(incrementedNonResponders[0].memberGroupId)) {
              expect(incrementedNonResponders[0].memberGroupId.value).toBe(GROUP_ID_A);
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'incrementMissedForEventNonRespondersByEventId NOT called when startEvent returns None (idempotency at cron seam)',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Already Started',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const ReturnsNoneEventsRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (_eventId: Event.EventId) => Effect.succeed(Option.none()),
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // No transition → NOT called
            expect(incrementedNonResponders).toHaveLength(0);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            ReturnsNoneEventsRepo,
            MockEventSyncEventsRepositoryLayer,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  // -------------------------------------------------------------------------
  // T12.C — Change A server: training role routing + claimedByMemberId
  // -------------------------------------------------------------------------
  // These tests FAIL until EventStartCron branches on event_type === 'training'
  // to resolve the OWNERS group role (not member-group role), and passes
  // event.claimed_by as the new claimedByMemberId param to emitEventStarted.

  it.effect(
    'T12.C.1: training WITH claimed_by → emitEventStarted receives claimedByMemberId, discordRoleId = owners role',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Training With Coach',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          // member_group_id maps to ROLE_ID (member-group role)
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          // owner_group_id maps to OWNERS_ROLE_ID
          owner_group_id: Option.some(OWNER_GROUP_ID),
          reminders_channel_id: Option.none(),
          claimed_by: Option.some(MEMBER_ID),
        },
      ];
      // Seed BOTH mappings so the test can disambiguate
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(ROLE_ID), // member-group role
      });
      channelMappings.set(`${TEAM_ID}:${OWNER_GROUP_ID}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(OWNERS_ROLE_ID), // owners-group role
      });

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedStarted).toHaveLength(1);
            const emitted = emittedStarted[0];
            // claimedByMemberId must be the coach's member id
            expect(Option.isSome(emitted.claimedByMemberId)).toBe(true);
            if (Option.isSome(emitted.claimedByMemberId)) {
              expect(emitted.claimedByMemberId.value).toBe(MEMBER_ID);
            }
            // discordRoleId must be the OWNERS role, not the member-group role
            expect(Option.isSome(emitted.discordRoleId)).toBe(true);
            if (Option.isSome(emitted.discordRoleId)) {
              expect(emitted.discordRoleId.value).toBe(OWNERS_ROLE_ID);
              expect(emitted.discordRoleId.value).not.toBe(ROLE_ID);
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T12.C.2: training with NO claimed_by → claimedByMemberId None, discordRoleId = owners role',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Training No Coach',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.some(OWNER_GROUP_ID),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(ROLE_ID),
      });
      channelMappings.set(`${TEAM_ID}:${OWNER_GROUP_ID}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(OWNERS_ROLE_ID),
      });

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedStarted).toHaveLength(1);
            const emitted = emittedStarted[0];
            // No coach
            expect(Option.isNone(emitted.claimedByMemberId)).toBe(true);
            // Still uses owners role
            expect(Option.isSome(emitted.discordRoleId)).toBe(true);
            if (Option.isSome(emitted.discordRoleId)) {
              expect(emitted.discordRoleId.value).toBe(OWNERS_ROLE_ID);
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T12.C.3: non-training (match) → claimedByMemberId None, discordRoleId = member-group role (unchanged behavior)',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Saturday Match',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.some(OWNER_GROUP_ID),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(ROLE_ID), // member-group role
      });
      channelMappings.set(`${TEAM_ID}:${OWNER_GROUP_ID}`, {
        discord_channel_id: CHANNEL_OWNER,
        discord_role_id: Option.some(OWNERS_ROLE_ID), // owners role (must NOT be used for match)
      });

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedStarted).toHaveLength(1);
            const emitted = emittedStarted[0];
            // No claimedByMemberId for non-training events
            expect(Option.isNone(emitted.claimedByMemberId)).toBe(true);
            // discordRoleId must use the MEMBER group role, not the owners role
            expect(Option.isSome(emitted.discordRoleId)).toBe(true);
            if (Option.isSome(emitted.discordRoleId)) {
              expect(emitted.discordRoleId.value).toBe(ROLE_ID);
              expect(emitted.discordRoleId.value).not.toBe(OWNERS_ROLE_ID);
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect('T12.C.4: training with no owners-group mapping → discordRoleId None', () => {
    eventsToStart = [
      {
        id: EVENT_ID_1,
        team_id: TEAM_ID,
        title: 'Training No Owners Mapping',
        description: Option.none(),
        start_at: START_AT,
        end_at: Option.none(),
        location: Option.none(),
        event_type: 'training',
        member_group_id: Option.some(GROUP_ID_A),
        discord_target_channel_id: Option.none(),
        owner_group_id: Option.some(OWNER_GROUP_ID),
        reminders_channel_id: Option.none(),
        claimed_by: Option.none(),
      },
    ];
    // Only seed the member-group mapping, NOT the owner-group mapping
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: CHANNEL_OWNER,
      discord_role_id: Option.some(ROLE_ID),
    });
    // No mapping for OWNER_GROUP_ID

    return eventStartCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedStarted).toHaveLength(1);
          // discordRoleId must be None since owners group has no channel mapping
          expect(Option.isNone(emittedStarted[0].discordRoleId)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  // -------------------------------------------------------------------------
  // T-dirty — personal-messages "dirty" bookkeeping (fix/personal-messages-dirty-sweep)
  // -------------------------------------------------------------------------
  // These tests FAIL until EventStartCron:
  //   (1) calls eventsRepo.markEventPersonalMessagesDirty(event.id) as a best-effort tap
  //       right after the active→started flip (after the missed-RSVP increment, before
  //       the Discord role/channel resolution and emitEventStarted), and
  //   (2) calls eventsRepo.markStalePersonalMessagesDirty() once per cron cycle,
  //       independent of the per-event loop.

  it.effect(
    'T-dirty.1: active→started marks the event personal-messages dirty and still emits the sync event',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Dirty Flag Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(dirtyMarked).toContain(EVENT_ID_1);
            expect(emittedStarted).toHaveLength(1);
            expect(emittedStarted[0].eventId).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.2: dirtyMarked stays empty when startEvent returns None (no active→started transition)',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Already Started',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const ReturnsNoneRepoLocal = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (_eventId: Event.EventId) => Effect.succeed(Option.none()),
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(dirtyMarked).toHaveLength(0);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            ReturnsNoneRepoLocal,
            MockEventSyncEventsRepositoryLayer,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.3: markEventPersonalMessagesDirty dying does not fail the cron; emitEventStarted still runs',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Dirty Mark Failure Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const DyingDirtyMarkRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (eventId: Event.EventId) => {
          startedEvents.push({ eventId });
          return Effect.succeed(Option.some({ id: eventId }));
        },
        markEventPersonalMessagesDirty: (_eventId: Event.EventId) =>
          Effect.die(new Error('Simulated dirty-mark failure')),
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // The cron completed without failing (the die was caught by a
            // catchCause→logWarning backstop) and emitEventStarted still ran.
            expect(emittedStarted).toHaveLength(1);
            expect(emittedStarted[0].eventId).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            DyingDirtyMarkRepo,
            MockEventSyncEventsRepositoryLayer,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.4: dirtyMarked still contains the event id even when emitEventStarted dies after the flip',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Emit Failure After Dirty Mark',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'training',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const DyingEmitRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (eventId: Event.EventId) => {
          startedEvents.push({ eventId });
          return Effect.succeed(Option.some({ id: eventId }));
        },
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      const DyingEmitSyncRepo = Layer.succeed(EventSyncEventsRepository, {
        emitEventStarted: () => Effect.die(new Error('Simulated emit failure')),
        emitEventCreated: () => Effect.void,
        emitEventUpdated: () => Effect.void,
        emitEventCancelled: () => Effect.void,
        emitRsvpReminder: () => Effect.void,
        findUnprocessed: () => Effect.succeed([]),
        markProcessed: () => Effect.void,
        markFailed: () => Effect.void,
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // The dirty-mark tap runs BEFORE emitEventStarted, so it must have
            // already recorded the event even though emitEventStarted blew up
            // (and its per-event Effect.exit backstop swallowed the failure).
            expect(dirtyMarked).toContain(EVENT_ID_1);
            expect(emittedStarted).toHaveLength(0);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            DyingEmitRepo,
            DyingEmitSyncRepo,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.4b: dirtyMarked still contains the event id even when Discord role/channel resolution dies after the flip',
    () => {
      // Pins the "before the Discord role/channel binds" half of the placement
      // claim (T-dirty.4 above only pins "before emitEventStarted"). Uses a
      // 'match' event with a Some member_group_id so resolveGroupRoleId actually
      // calls DiscordChannelMappingRepository#findByGroupId (it short-circuits
      // to None without calling the repo when member_group_id is None).
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Discord Resolution Failure After Dirty Mark',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.some(GROUP_ID_A),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const DyingDiscordResolutionRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (eventId: Event.EventId) => {
          startedEvents.push({ eventId });
          return Effect.succeed(Option.some({ id: eventId }));
        },
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () => {
          staleSweepCalls++;
          return Effect.void;
        },
      } as any);

      const DyingChannelMappingRepo = Layer.succeed(DiscordChannelMappingRepository, {
        findByGroupId: () => Effect.die(new Error('Simulated Discord channel-mapping failure')),
        insert: () => Effect.void,
        insertWithoutRole: () => Effect.void,
        deleteByGroupId: () => Effect.void,
        findAllByTeamId: () => Effect.succeed([]),
        findAllByTeam: () => Effect.succeed([]),
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // The dirty-mark tap runs BEFORE the Discord role/channel binds, so
            // it must have already recorded the event even though resolving the
            // Discord role blew up (and the per-event Effect.exit backstop
            // swallowed the failure).
            expect(dirtyMarked).toContain(EVENT_ID_1);
            expect(emittedStarted).toHaveLength(0);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            DyingDiscordResolutionRepo,
            MockEventSyncEventsRepositoryLayer,
            DyingChannelMappingRepo,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.5: markStalePersonalMessagesDirty is called exactly once per cron cycle when there is nothing to start',
    () => {
      eventsToStart = [];

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(staleSweepCalls).toBe(1);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.6: markStalePersonalMessagesDirty is called exactly once per cron cycle even when events are started',
    () => {
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Sweep Alongside Started Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
        {
          id: EVENT_ID_2,
          team_id: TEAM_ID,
          title: 'Second Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Sweep runs once per cycle regardless of how many events were processed.
            expect(staleSweepCalls).toBe(1);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'T-dirty.7: markStalePersonalMessagesDirty dying does not fail the cron cycle; per-event processing still runs',
    () => {
      // Enforces the catchCause backstop on the once-per-cycle sweep: even if the
      // sweep itself dies, the cron cycle must still complete AND still process
      // events (a missing/absent backstop would propagate the die and abort the
      // whole cycle, which would make emittedStarted come back empty).
      eventsToStart = [
        {
          id: EVENT_ID_1,
          team_id: TEAM_ID,
          title: 'Sweep Failure Alongside Started Event',
          description: Option.none(),
          start_at: START_AT,
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
          member_group_id: Option.none(),
          discord_target_channel_id: Option.none(),
          owner_group_id: Option.none(),
          reminders_channel_id: Option.none(),
          claimed_by: Option.none(),
        },
      ];

      const DyingSweepRepo = Layer.succeed(EventsRepository, {
        findEventsToStart: () => Effect.succeed(eventsToStart),
        startEvent: (eventId: Event.EventId) => {
          startedEvents.push({ eventId });
          return Effect.succeed(Option.some({ id: eventId }));
        },
        markEventPersonalMessagesDirty: (eventId: Event.EventId) => {
          dirtyMarked.push(eventId);
          return Effect.void;
        },
        markStalePersonalMessagesDirty: () =>
          Effect.die(new Error('Simulated stale-sweep failure')),
      } as any);

      return eventStartCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedStarted).toHaveLength(1);
            expect(emittedStarted[0].eventId).toBe(EVENT_ID_1);
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            DyingSweepRepo,
            MockEventSyncEventsRepositoryLayer,
            MockChannelMappingRepositoryLayer,
            MockEventRsvpsRepositoryLayer,
          ),
        ),
        Effect.asVoid,
      );
    },
  );
});
