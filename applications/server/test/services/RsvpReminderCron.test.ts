// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference APIs/signatures that do not yet exist on the server:
//   - rsvpReminderCronEffect (exported from RsvpReminderCron.ts)
//   - DiscordChannelMappingRepository.findByGroupId returning discord_role_id
//   - resolveReminderChannel helper in EventChannelResolver.ts
//   - emitRsvpReminder accepting member_group_id and discord_role_id
//   - findEventsNeedingReminder returning reminders_channel_id, member_group_id,
//     discord_role_id and timezone from the new schema
// They will FAIL to compile / run until the developer implements the server task.
//
// Cases 15-17 (unclaimed_training_reminder) are added at the bottom in TDD mode:
//   - emitUnclaimedTrainingReminder on EventSyncEventsRepository does not yet exist.
//   - EventNeedingReminder schema does not yet have claimed_by / discord_message_id fields.
//   These tests will FAIL until the developer adds those fields and the cron logic.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { rsvpReminderCronEffect } from '~/services/RsvpReminderCron.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const EVENT_ID_1 = '00000000-0000-0000-0000-000000000001' as Event.EventId;
const EVENT_ID_2 = '00000000-0000-0000-0000-000000000002' as Event.EventId;
const GROUP_ID_A = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const CHANNEL_REMINDERS = '111111111111111111' as Discord.Snowflake;
const CHANNEL_OWNER = '222222222222222222' as Discord.Snowflake;
const ROLE_ID = '333333333333333333' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type ReminderEvent = {
  event_id: Event.EventId;
  team_id: Team.TeamId;
  title: string;
  start_at: Date;
  event_type: string;
  discord_target_channel_id: Option.Option<Discord.Snowflake>;
  owner_group_id: Option.Option<GroupModel.GroupId>;
  member_group_id: Option.Option<GroupModel.GroupId>;
  /** Channel from team_settings.reminders_channel_id */
  reminders_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

type EmittedReminder = {
  teamId: Team.TeamId;
  eventId: Event.EventId;
  channelId: Option.Option<Discord.Snowflake>;
  memberGroupId: Option.Option<GroupModel.GroupId>;
  discordRoleId: Option.Option<Discord.Snowflake>;
};

let eventsNeedingReminder: ReminderEvent[];
let markedReminderSent: Event.EventId[];
let emittedReminders: EmittedReminder[];
let channelMappings: Map<
  string,
  {
    discord_channel_id: Option.Option<Discord.Snowflake>;
    discord_role_id: Option.Option<Discord.Snowflake>;
  }
>;

const resetStores = () => {
  eventsNeedingReminder = [];
  markedReminderSent = [];
  emittedReminders = [];
  channelMappings = new Map();
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamSettingsRepository = () =>
  Layer.succeed(TeamSettingsRepository, {
    findEventsNeedingReminder: () => Effect.succeed(eventsNeedingReminder),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
  } as any);

const makeMockEventsRepository = (
  overrides: Partial<{ markReminderSent: (id: Event.EventId) => Effect.Effect<void> }> = {},
) =>
  Layer.succeed(EventsRepository, {
    markReminderSent:
      overrides.markReminderSent ??
      ((id: Event.EventId) => {
        markedReminderSent.push(id);
        return Effect.void;
      }),
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
  } as any);

const makeMockSyncEventsRepository = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitRsvpReminder: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _description: Option.Option<string>,
      _startAt: unknown,
      _endAt: Option.Option<unknown>,
      _location: Option.Option<string>,
      _eventType: string,
      channelId: Option.Option<Discord.Snowflake>,
      memberGroupId: Option.Option<GroupModel.GroupId>,
      discordRoleId: Option.Option<Discord.Snowflake>,
    ) => {
      emittedReminders.push({ teamId, eventId, channelId, memberGroupId, discordRoleId });
      return Effect.void;
    },
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitEventStarted: () => Effect.void,
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

const buildMockLayer = (
  eventsRepoOverrides?: Partial<{ markReminderSent: (id: Event.EventId) => Effect.Effect<void> }>,
) =>
  Layer.mergeAll(
    makeMockTeamSettingsRepository(),
    makeMockEventsRepository(eventsRepoOverrides),
    makeMockSyncEventsRepository(),
    makeMockChannelMappingRepository(),
  );

const makeBaseEvent = (
  id: Event.EventId,
  overrides: Partial<ReminderEvent> = {},
): ReminderEvent => ({
  event_id: id,
  team_id: TEAM_ID,
  title: 'Test Event',
  start_at: new Date('2026-05-01T16:00:00Z'),
  event_type: 'training',
  discord_target_channel_id: Option.none(),
  owner_group_id: Option.none(),
  member_group_id: Option.none(),
  reminders_channel_id: Option.none(),
  discord_role_id: Option.none(),
  ...overrides,
});

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// T6.1 — cron fires when scheduled; emits and marks reminder sent
// ---------------------------------------------------------------------------

describe('rsvpReminderCronEffect', () => {
  it.effect('emits reminder and marks it sent for a single event', () => {
    eventsNeedingReminder = [makeBaseEvent(EVENT_ID_1)];

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          expect(emittedReminders[0].eventId).toBe(EVENT_ID_1);
          expect(markedReminderSent).toHaveLength(1);
          expect(markedReminderSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  it.effect('does nothing when no events need reminders', () => {
    eventsNeedingReminder = [];

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(0);
          expect(markedReminderSent).toHaveLength(0);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.2 — markReminderSent only after successful emit
  it.effect('does NOT call markReminderSent if emit fails', () => {
    eventsNeedingReminder = [makeBaseEvent(EVENT_ID_1)];

    const FailingEmitLayer = Layer.succeed(EventSyncEventsRepository, {
      emitRsvpReminder: () => Effect.die(new Error('emit failed')),
      emitEventCreated: () => Effect.void,
      emitEventUpdated: () => Effect.void,
      emitEventCancelled: () => Effect.void,
      emitEventStarted: () => Effect.void,
      findUnprocessed: () => Effect.succeed([]),
      markProcessed: () => Effect.void,
      markFailed: () => Effect.void,
    } as any);

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // emit failed → markReminderSent must NOT have been called
          expect(markedReminderSent).toHaveLength(0);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          makeMockTeamSettingsRepository(),
          makeMockEventsRepository(),
          FailingEmitLayer,
          makeMockChannelMappingRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  // T6.3 — per-event error isolation
  it.effect('continues processing remaining events after one fails', () => {
    eventsNeedingReminder = [makeBaseEvent(EVENT_ID_1), makeBaseEvent(EVENT_ID_2)];

    // Make the first event's markReminderSent throw; the second should still succeed
    let callCount = 0;
    const PartiallyFailingEventsRepo = makeMockEventsRepository({
      markReminderSent: (id: Event.EventId) => {
        callCount++;
        if (callCount === 1) return Effect.die(new Error('mark failed for first event'));
        markedReminderSent.push(id);
        return Effect.void;
      },
    });

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // First event failed but second should succeed
          expect(markedReminderSent).toContain(EVENT_ID_2);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          makeMockTeamSettingsRepository(),
          PartiallyFailingEventsRepo,
          makeMockSyncEventsRepository(),
          makeMockChannelMappingRepository(),
        ),
      ),
      Effect.asVoid,
    );
  });

  // T6.4 — channel resolution: reminders_channel_id takes priority
  it.effect('uses reminders_channel_id when present', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        reminders_channel_id: Option.some(CHANNEL_REMINDERS),
        owner_group_id: Option.some(GROUP_ID_A),
      }),
    ];
    // Also set up a mapping so we know it wasn't used
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(CHANNEL_OWNER),
      discord_role_id: Option.none(),
    });

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          const emitted = emittedReminders[0];
          expect(Option.isSome(emitted.channelId)).toBe(true);
          if (Option.isSome(emitted.channelId)) {
            expect(emitted.channelId.value).toBe(CHANNEL_REMINDERS);
          }
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.4 — channel resolution: owner_group fallback when reminders_channel_id absent
  it.effect('falls back to owner_group channel when reminders_channel_id is None', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        reminders_channel_id: Option.none(),
        owner_group_id: Option.some(GROUP_ID_A),
      }),
    ];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(CHANNEL_OWNER),
      discord_role_id: Option.none(),
    });

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          const emitted = emittedReminders[0];
          expect(Option.isSome(emitted.channelId)).toBe(true);
          if (Option.isSome(emitted.channelId)) {
            expect(emitted.channelId.value).toBe(CHANNEL_OWNER);
          }
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.4 — channel resolution: no channel → None
  it.effect(
    'emits with None channel when both reminders_channel_id and owner_group are absent',
    () => {
      eventsNeedingReminder = [
        makeBaseEvent(EVENT_ID_1, {
          reminders_channel_id: Option.none(),
          owner_group_id: Option.none(),
        }),
      ];

      return rsvpReminderCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedReminders).toHaveLength(1);
            expect(Option.isNone(emittedReminders[0].channelId)).toBe(true);
          }),
        ),
        Effect.provide(buildMockLayer()),
        Effect.asVoid,
      );
    },
  );

  // T6.5 — role resolution: no member_group_id → None discord_role_id
  it.effect('emits with None discord_role_id when member_group_id is None', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        member_group_id: Option.none(),
      }),
    ];

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          expect(Option.isNone(emittedReminders[0].discordRoleId)).toBe(true);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.5 — role resolution: member_group_id but no mapping → None discord_role_id
  it.effect('emits with None discord_role_id when member_group has no channel mapping', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        member_group_id: Option.some(GROUP_ID_A),
      }),
    ];
    // No entry in channelMappings for this group

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          expect(Option.isNone(emittedReminders[0].discordRoleId)).toBe(true);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.5 — role resolution: mapping exists but discord_role_id is None
  it.effect('emits with None discord_role_id when mapping has no role', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        member_group_id: Option.some(GROUP_ID_A),
      }),
    ];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(CHANNEL_OWNER),
      discord_role_id: Option.none(),
    });

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          expect(Option.isNone(emittedReminders[0].discordRoleId)).toBe(true);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.5 — role resolution: mapping has role → discord_role_id forwarded
  it.effect('emits discord_role_id from channel mapping when available', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        member_group_id: Option.some(GROUP_ID_A),
      }),
    ];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(CHANNEL_OWNER),
      discord_role_id: Option.some(ROLE_ID),
    });

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          const emitted = emittedReminders[0];
          expect(Option.isSome(emitted.discordRoleId)).toBe(true);
          if (Option.isSome(emitted.discordRoleId)) {
            expect(emitted.discordRoleId.value).toBe(ROLE_ID);
          }
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  // T6.6 — member_group_id forwarded in emit
  it.effect('forwards member_group_id in the emitted reminder', () => {
    eventsNeedingReminder = [
      makeBaseEvent(EVENT_ID_1, {
        member_group_id: Option.some(GROUP_ID_A),
      }),
    ];

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedReminders).toHaveLength(1);
          const emitted = emittedReminders[0];
          expect(Option.isSome(emitted.memberGroupId)).toBe(true);
          if (Option.isSome(emitted.memberGroupId)) {
            expect(emitted.memberGroupId.value).toBe(GROUP_ID_A);
          }
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Cases 15-17 — unclaimed_training_reminder emission
//
// The cron should also emit unclaimed_training_reminder for trainings that:
//   - are active training events (event_type = 'training')
//   - have claimed_by IS NULL
//   - have an owner group with a Discord channel mapping
//   - have NOT yet sent an unclaimed reminder (or just always on reminder window)
//
// These tests reference:
//   - ReminderEvent.claimed_by (new field — does not yet exist in schema)
//   - ReminderEvent.claim_discord_channel_id / claim_discord_message_id (for jump link)
//   - EventSyncEventsRepository.emitUnclaimedTrainingReminder (does not yet exist)
//
// They WILL FAIL until the developer adds these fields and the cron logic.
// ---------------------------------------------------------------------------

// Extra IDs for unclaimed reminder tests
const EVENT_ID_UNCLAIMED_TRAINING = '00000000-0000-0000-0000-000000000010' as Event.EventId;
const EVENT_ID_CLAIMED_TRAINING = '00000000-0000-0000-0000-000000000011' as Event.EventId;
const COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const CLAIM_CHANNEL = '666666666666666666' as Discord.Snowflake;
const CLAIM_MESSAGE_ID = '777777777777777777' as Discord.Snowflake;

// Extend the ReminderEvent type to include the new fields that the implementation will add.
// (These fields do not yet exist — the EventNeedingReminder schema will be extended.)
type ExtendedReminderEvent = ReminderEvent & {
  /** claimed_by IS NULL means unclaimed */
  claimed_by: Option.Option<TeamMember.TeamMemberId>;
  /** Discord channel + message IDs for the claim message (for jump link) */
  claim_discord_channel_id: Option.Option<Discord.Snowflake>;
  claim_discord_message_id: Option.Option<Discord.Snowflake>;
};

type EmittedUnclaimedReminder = {
  teamId: Team.TeamId;
  eventId: Event.EventId;
  discordTargetChannelId: Discord.Snowflake;
  discordRoleId: Option.Option<Discord.Snowflake>;
  claimDiscordChannelId: Option.Option<Discord.Snowflake>;
  claimDiscordMessageId: Option.Option<Discord.Snowflake>;
};

let emittedUnclaimedReminders: EmittedUnclaimedReminder[];

const makeExtendedBaseEvent = (
  id: Event.EventId,
  overrides: Partial<ExtendedReminderEvent> = {},
): ExtendedReminderEvent => ({
  event_id: id,
  team_id: TEAM_ID,
  title: 'Test Training',
  start_at: new Date('2026-05-01T16:00:00Z'),
  event_type: 'training',
  discord_target_channel_id: Option.none(),
  owner_group_id: Option.some(GROUP_ID_A),
  member_group_id: Option.none(),
  reminders_channel_id: Option.none(),
  discord_role_id: Option.none(),
  claimed_by: Option.none(),
  claim_discord_channel_id: Option.none(),
  claim_discord_message_id: Option.none(),
  ...overrides,
});

const makeMockSyncEventsWithUnclaimedReminder = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitRsvpReminder: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _description: Option.Option<string>,
      _startAt: unknown,
      _endAt: Option.Option<unknown>,
      _location: Option.Option<string>,
      _eventType: string,
      channelId: Option.Option<Discord.Snowflake>,
      memberGroupId: Option.Option<GroupModel.GroupId>,
      discordRoleId: Option.Option<Discord.Snowflake>,
    ) => {
      emittedReminders.push({ teamId, eventId, channelId, memberGroupId, discordRoleId });
      return Effect.void;
    },
    // New method: emitUnclaimedTrainingReminder
    emitUnclaimedTrainingReminder: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _startAt: unknown,
      _endAt: unknown,
      _location: unknown,
      discordTargetChannelId: Discord.Snowflake,
      discordRoleId: Option.Option<Discord.Snowflake>,
      claimDiscordChannelId: Option.Option<Discord.Snowflake>,
      claimDiscordMessageId: Option.Option<Discord.Snowflake>,
    ) => {
      emittedUnclaimedReminders.push({
        teamId,
        eventId,
        discordTargetChannelId,
        discordRoleId,
        claimDiscordChannelId,
        claimDiscordMessageId,
      });
      return Effect.void;
    },
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitEventStarted: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const buildUnclaimedReminderMockLayer = () =>
  Layer.mergeAll(
    makeMockTeamSettingsRepository(),
    makeMockEventsRepository(),
    makeMockSyncEventsWithUnclaimedReminder(),
    makeMockChannelMappingRepository(),
  );

describe('rsvpReminderCronEffect — unclaimed_training_reminder', () => {
  beforeEach(() => {
    resetStores();
    emittedUnclaimedReminders = [];
  });

  afterEach(() => {
    resetStores();
    emittedUnclaimedReminders = [];
  });

  // Case 15: emits unclaimed_training_reminder when training+unclaimed+owner-channel
  it.effect(
    'emits unclaimed_training_reminder for an unclaimed training with owner-group channel',
    () => {
      const event = makeExtendedBaseEvent(EVENT_ID_UNCLAIMED_TRAINING, {
        event_type: 'training',
        claimed_by: Option.none(),
        owner_group_id: Option.some(GROUP_ID_A),
        claim_discord_channel_id: Option.some(CLAIM_CHANNEL),
        claim_discord_message_id: Option.some(CLAIM_MESSAGE_ID),
      });
      channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
        discord_channel_id: Option.some(CHANNEL_OWNER),
        discord_role_id: Option.none(),
      });
      eventsNeedingReminder = [event as any];

      return rsvpReminderCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const unclaimedEmitted = emittedUnclaimedReminders.filter(
              (e) => e.eventId === EVENT_ID_UNCLAIMED_TRAINING,
            );
            expect(unclaimedEmitted).toHaveLength(1);
            expect(unclaimedEmitted[0].discordTargetChannelId).toBe(CHANNEL_OWNER);
          }),
        ),
        Effect.provide(buildUnclaimedReminderMockLayer()),
        Effect.asVoid,
      );
    },
  );

  // Case 16: does NOT emit when claimed_by IS NOT NULL
  it.effect('does NOT emit unclaimed_training_reminder when training is already claimed', () => {
    const event = makeExtendedBaseEvent(EVENT_ID_CLAIMED_TRAINING, {
      event_type: 'training',
      claimed_by: Option.some(COACH_MEMBER_ID),
      owner_group_id: Option.some(GROUP_ID_A),
      claim_discord_channel_id: Option.some(CLAIM_CHANNEL),
      claim_discord_message_id: Option.some(CLAIM_MESSAGE_ID),
    });
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(CHANNEL_OWNER),
      discord_role_id: Option.none(),
    });
    eventsNeedingReminder = [event as any];

    return rsvpReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedUnclaimedReminders).toHaveLength(0);
        }),
      ),
      Effect.provide(buildUnclaimedReminderMockLayer()),
      Effect.asVoid,
    );
  });

  // Case 17: does NOT emit when owner-group has no channel mapping
  it.effect(
    'does NOT emit unclaimed_training_reminder when owner-group has no channel mapping',
    () => {
      const event = makeExtendedBaseEvent(EVENT_ID_UNCLAIMED_TRAINING, {
        event_type: 'training',
        claimed_by: Option.none(),
        owner_group_id: Option.some(GROUP_ID_A),
        claim_discord_channel_id: Option.none(),
        claim_discord_message_id: Option.none(),
      });
      // No channel mapping for GROUP_ID_A
      eventsNeedingReminder = [event as any];

      return rsvpReminderCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedUnclaimedReminders).toHaveLength(0);
          }),
        ),
        Effect.provide(buildUnclaimedReminderMockLayer()),
        Effect.asVoid,
      );
    },
  );
});
