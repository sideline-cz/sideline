// NOTE: CoachingStatusCron resolves the target channel via the event's
// owner-group channel mapping only (the `discord_channel_training` per-type
// channel was removed — see Release A of remove-channel-by-type).
//   - owner-group channel resolvable → emits to it + markCoachingStatusSent
//   - owner_group_id is None → warns + marks sent, no emit
//   - owner group present but has no channel mapping → warns + marks sent, no emit
//
// ASSUMPTION: coachingStatusCronEffect is exported from ~/services/CoachingStatusCron.ts.
// ASSUMPTION: EventsRepository.markCoachingStatusSent(eventId) does:
//   UPDATE events SET coaching_status_sent_at = now() WHERE id = $eventId.
// ASSUMPTION: EventSyncEventsRepository.emitCoachingStatus(teamId, eventId, ...) exists.
// ASSUMPTION: TeamSettingsRepository.findEventsNeedingCoachingStatus() returns events
//   that are CLAIMED, starting later today, after 07:00 local, coaching_status_sent_at IS NULL.
// ASSUMPTION: EventNeedingCoachingStatus has: event_id, team_id, title, start_at,
//   owner_group_id, claimed_by, claimer_display_name, claimer_discord_id.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { coachingStatusCronEffect } from '~/services/CoachingStatusCron.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const EVENT_ID_1 = '00000000-0000-0000-0000-000000000201' as Event.EventId;
const GROUP_ID_A = '00000000-0000-0000-0000-000000000050' as GroupModel.GroupId;
const OWNER_CHANNEL = '555555555555555555' as Discord.Snowflake;
const MEMBER_ID = '00000000-0000-0000-0000-000000000060' as TeamMember.TeamMemberId;
const COACH_DISCORD_ID = '666666666666666666' as Discord.Snowflake;
const COACH_NAME = 'Coach Alice';

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type CoachingEvent = {
  event_id: Event.EventId;
  team_id: Team.TeamId;
  title: string;
  start_at: DateTime.Utc;
  owner_group_id: Option.Option<GroupModel.GroupId>;
  claimed_by: Option.Option<TeamMember.TeamMemberId>;
  claimer_display_name: Option.Option<string>;
  claimer_discord_id: Option.Option<Discord.Snowflake>;
};

let pendingCoachingEvents: CoachingEvent[];
let markedCoachingStatusSent: Event.EventId[];
let emittedCoachingStatuses: Array<{
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
  pendingCoachingEvents = [];
  markedCoachingStatusSent = [];
  emittedCoachingStatuses = [];
  channelMappings = new Map();
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamSettings = () =>
  Layer.succeed(TeamSettingsRepository, {
    findEventsNeedingCoachingStatus: () => Effect.succeed(pendingCoachingEvents),
    findEventsNeedingCoachingStatusAt: () => Effect.succeed(pendingCoachingEvents),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
    findEventsNeedingReminder: () => Effect.succeed([]),
    findEventsNeedingReminderAt: () => Effect.succeed([]),
  } as any);

const makeMockEventsRepo = () =>
  Layer.succeed(EventsRepository, {
    markCoachingStatusSent: (id: Event.EventId) => {
      markedCoachingStatusSent.push(id);
      return Effect.void;
    },
    markReminderSent: () => Effect.void,
    markClaimRequestSent: () => Effect.void,
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

const makeMockSyncEvents = () =>
  Layer.succeed(EventSyncEventsRepository, {
    // ASSUMPTION: emitCoachingStatus signature: (teamId, eventId, title, startAt,
    //   discordTargetChannelId, claimedByDisplayName, claimedByDiscordId, location)
    emitCoachingStatus: (
      teamId: Team.TeamId,
      eventId: Event.EventId,
      _title: string,
      _startAt: unknown,
      channelId: Discord.Snowflake,
    ) => {
      emittedCoachingStatuses.push({ teamId, eventId, channelId });
      return Effect.void;
    },
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitEventStarted: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitTrainingClaimRequest: () => Effect.void,
    emitTrainingClaimUpdate: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeMockChannelMapping = () =>
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

const buildLayer = () =>
  Layer.mergeAll(
    makeMockTeamSettings(),
    makeMockEventsRepo(),
    makeMockSyncEvents(),
    makeMockChannelMapping(),
  );

const makeCoachingEvent = (overrides: Partial<CoachingEvent> = {}): CoachingEvent => ({
  event_id: EVENT_ID_1,
  team_id: TEAM_ID,
  title: 'Monday Training',
  start_at: DateTime.makeUnsafe('2026-06-01T14:00:00Z'),
  owner_group_id: Option.some(GROUP_ID_A),
  claimed_by: Option.some(MEMBER_ID),
  claimer_display_name: Option.some(COACH_NAME),
  claimer_discord_id: Option.some(COACH_DISCORD_ID),
  ...overrides,
});

beforeEach(() => resetStores());
afterEach(() => resetStores());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoachingStatusCron — coachingStatusCronEffect', () => {
  it.effect('owner-group channel resolvable → emitCoachingStatus + markCoachingStatusSent', () => {
    pendingCoachingEvents = [makeCoachingEvent({ owner_group_id: Option.some(GROUP_ID_A) })];
    channelMappings.set(`${TEAM_ID}:${GROUP_ID_A}`, {
      discord_channel_id: Option.some(OWNER_CHANNEL),
      discord_role_id: Option.none(),
    });

    return coachingStatusCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCoachingStatuses).toHaveLength(1);
          expect(emittedCoachingStatuses[0].channelId).toBe(OWNER_CHANNEL);
          expect(markedCoachingStatusSent).toHaveLength(1);
          expect(markedCoachingStatusSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });

  it.effect('owner_group_id is None → warns + marks sent, no emit', () => {
    pendingCoachingEvents = [makeCoachingEvent({ owner_group_id: Option.none() })];

    return coachingStatusCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCoachingStatuses).toHaveLength(0);
          // Must still mark sent to prevent infinite rescan
          expect(markedCoachingStatusSent).toHaveLength(1);
          expect(markedCoachingStatusSent[0]).toBe(EVENT_ID_1);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });

  it.effect('owner group without a channel mapping → warns + marks sent, no emit', () => {
    pendingCoachingEvents = [makeCoachingEvent({ owner_group_id: Option.some(GROUP_ID_A) })];
    // No channel mapping registered for GROUP_ID_A

    return coachingStatusCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCoachingStatuses).toHaveLength(0);
          expect(markedCoachingStatusSent).toHaveLength(1);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });

  it.effect('empty pending list → does nothing', () => {
    pendingCoachingEvents = [];

    return coachingStatusCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedCoachingStatuses).toHaveLength(0);
          expect(markedCoachingStatusSent).toHaveLength(0);
        }),
      ),
      Effect.provide(buildLayer()),
      Effect.asVoid,
    );
  });
});
