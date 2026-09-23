// Nastavitelná docházka (plan §6.7, §10.2, Setting 2). `Event/GetRsvpReminderSummary`
// is the sole consumer feeding `handleRsvpReminder.ts`'s DM loop — the opt-out
// (`team_members.rsvp_reminder_dms`) must be filtered HERE, and only here, so a
// member who muted the reminder DM stops receiving it while every other reader
// of non-responder data (the organiser's admin view, the missed-RSVP
// accounting) keeps seeing them in full (§6.7/§6.8, covered by sibling files).
//
// Real Postgres (testcontainers) — a mocked SqlClient cannot exercise the
// `eligible_members` CTE's role/group/missed_rsvps predicates or the new
// `rsvp_reminder_dms` column read.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Event, Role, Team, TeamMember, User } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { EventsRpcLive } from '~/rpc/event/index.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const PlainRepositories = Layer.mergeAll(
  EventsRepository.Default,
  EventRsvpsRepository.Default,
  EventSyncEventsRepository.Default,
  TeamMembersRepository.Default,
  GroupsRepository.Default,
  TrainingTypesRepository.Default,
  TeamsRepository.Default,
  TeamSettingsRepository.Default,
  ChannelEventDividersRepository.Default,
  DiscordChannelMappingRepository.Default,
  EventRostersRepository.Default,
  EventRosterRequestsRepository.Default,
  RostersRepository.Default,
  ChannelSyncEventsRepository.Default,
  UsersRepository.Default,
  RolesRepository.Default,
);

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(EventRosterProvisioningService.Default),
  Layer.provide(PlainRepositories),
  Layer.provideMerge(TestPgClient),
);

const SetupLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: Discord.Snowflake, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Reminder Opt-out Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

const getPlayerRoleId = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Player')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Player role not found')),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const assignRole = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const setReminderDms = (memberId: TeamMember.TeamMemberId, value: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET rsvp_reminder_dms = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Reminder Opt-out Test Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const submitRsvp = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  response: 'yes' | 'no' | 'maybe' = 'yes',
) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, response, Option.none())),
  );

/**
 * Seeds a team with roles and `count` Player members (each with a distinct
 * discord_id and username), none of whom have RSVP'd yet.
 */
const seedTeamWithPlayers = (suffix: string, count: number) =>
  Effect.Do.pipe(
    Effect.bind('ownerId', () =>
      createUser(`87000000000000${suffix}00` as Discord.Snowflake, `owner-ro-${suffix}`),
    ),
    Effect.bind('team', ({ ownerId }) =>
      createTeam(`8800000000000000${suffix}` as Discord.Snowflake, ownerId),
    ),
    Effect.tap(({ team }) => seedRoles(team.id)),
    Effect.bind('playerRoleId', ({ team }) => getPlayerRoleId(team.id)),
    Effect.bind('players', ({ team, playerRoleId }) =>
      Effect.all(
        Array.from({ length: count }, (_, i) => {
          const discordId = `87000000000000${suffix}${String(i + 1).padStart(
            2,
            '0',
          )}` as Discord.Snowflake;
          return Effect.Do.pipe(
            Effect.bind('userId', () => createUser(discordId, `player-ro-${suffix}-${i + 1}`)),
            Effect.bind('member', ({ userId }) => addTeamMember(team.id, userId)),
            Effect.tap(({ member }) => assignRole(member.id, playerRoleId)),
            Effect.map(({ member }) => ({ ...member, discordId })),
          );
        }),
        { concurrency: 1 },
      ),
    ),
    Effect.bind('event', ({ team, players }) => createEvent(team.id, players[0].id)),
  ).pipe(Effect.provide(SetupLayer), Effect.runPromise);

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

const callGetRsvpReminderSummary = (eventId: Event.EventId) =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/GetRsvpReminderSummary']({
            event_id: eventId,
          }) as Effect.Effect<EventRpcModels.RsvpReminderSummary, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Event/GetRsvpReminderSummary — Setting 2 (rsvp_reminder_dms opt-out)', () => {
  itEffect.effect(
    'opted-out member is not DMed: two eligible non-responders, one opted out → exactly one nonResponders entry, the opted-in one',
    () =>
      Effect.gen(function* () {
        const seed = yield* Effect.promise(() => seedTeamWithPlayers('01', 2));
        const [optedOut, optedIn] = seed.players;
        yield* setReminderDms(optedOut.id, false).pipe(Effect.provide(SetupLayer));
        // optedIn stays at the column default (true) — never explicitly set.

        const exit = yield* callGetRsvpReminderSummary(seed.event.id);
        const summary = Option.getOrThrowWith(
          Exit.getSuccess(exit),
          () => new Error('Expected RPC exit success'),
        );

        const ids = summary.nonResponders.map((r: any) => Option.getOrNull(r.discord_id));
        expect(ids).not.toContain(optedOut.discordId);
        expect(ids).toContain(optedIn.discordId);
        expect(ids).toHaveLength(1);
      }),
  );

  itEffect.effect('opted-in member (relying on the column default) is still DMed', () =>
    Effect.gen(function* () {
      const seed = yield* Effect.promise(() => seedTeamWithPlayers('02', 2));
      // Neither player's rsvp_reminder_dms is touched — both rely on the DEFAULT true.

      const exit = yield* callGetRsvpReminderSummary(seed.event.id);
      const summary = Option.getOrThrowWith(
        Exit.getSuccess(exit),
        () => new Error('Expected RPC exit success'),
      );

      const ids = summary.nonResponders.map((r: any) => Option.getOrNull(r.discord_id));
      expect(ids).toContain(seed.players[0].discordId);
      expect(ids).toContain(seed.players[1].discordId);
      expect(ids).toHaveLength(2);
    }),
  );

  itEffect.effect('a member who has responded never appears, regardless of rsvp_reminder_dms', () =>
    Effect.gen(function* () {
      const seed = yield* Effect.promise(() => seedTeamWithPlayers('03', 2));
      const [responded, optedOut] = seed.players;
      yield* submitRsvp(seed.event.id, responded.id, 'yes').pipe(Effect.provide(SetupLayer));
      yield* setReminderDms(optedOut.id, false).pipe(Effect.provide(SetupLayer));

      const exit = yield* callGetRsvpReminderSummary(seed.event.id);
      const summary = Option.getOrThrowWith(
        Exit.getSuccess(exit),
        () => new Error('Expected RPC exit success'),
      );

      const ids = summary.nonResponders.map((r: any) => Option.getOrNull(r.discord_id));
      expect(ids).not.toContain(responded.discordId);
      expect(ids).not.toContain(optedOut.discordId);
      expect(ids).toHaveLength(0);
    }),
  );

  itEffect.effect('counts are unchanged by the opt-out', () =>
    Effect.gen(function* () {
      const seed = yield* Effect.promise(() => seedTeamWithPlayers('04', 3));
      const [responder, optedOut] = seed.players;
      yield* submitRsvp(seed.event.id, responder.id, 'yes').pipe(Effect.provide(SetupLayer));
      yield* setReminderDms(optedOut.id, false).pipe(Effect.provide(SetupLayer));

      const exit = yield* callGetRsvpReminderSummary(seed.event.id);
      const summary = Option.getOrThrowWith(
        Exit.getSuccess(exit),
        () => new Error('Expected RPC exit success'),
      );

      // yesCount reflects the actual RSVP, unaffected by the reminder-DM opt-out —
      // the opt-out only trims `nonResponders`.
      expect(summary.yesCount).toBe(1);
      expect(summary.noCount).toBe(0);
      // Both non-responders (optedOut, optedIn) would count toward maybeCount only if
      // they had responded 'maybe' — here neither responded, so maybeCount is 0 too;
      // this asserts the opt-out does not leak into the counts at all.
      expect(summary.maybeCount).toBe(0);
    }),
  );
});
