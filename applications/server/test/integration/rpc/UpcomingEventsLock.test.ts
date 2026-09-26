// T9 — `rsvp_closes_at` on `UpcomingEventForUserEntry`, at BOTH producers.
//
// WRITTEN IN TDD MODE, BEFORE THE IMPLEMENTATION.
//
// This is the only test that proves the server ever computes a deadline for
// Discord, and the only one that catches a half-built Task 4.
// `UpcomingEventForUserEntry` is constructed in exactly two places:
//
//   rpc/event/index.ts:1129  → `Event/GetUpcomingEventsForUser`  (/event list)
//   rpc/guild/index.ts:1658  → `Guild/GetAllUpcomingEventsForUser` (PERSONAL CARDS)
//
// The second is the surface this feature is FOR. Because `rsvp_closes_at`
// decodes tolerantly (`OptionFromOptionalKey`), wiring only the first produces
// no compile error and no other failing test — the work would merge, demo
// green against `/event list`, and do nothing where it matters. Case 2 is the
// only thing standing in front of that, so every case below asserts against
// both endpoints, never one.
//
// The handlers cannot be unit-tested: `applications/server/test/
// GetUpcomingEventsForUserRpc.test.ts:1-8` says in its own header that the
// handler is raw SQL via @effect/sql and cannot have mocks injected at the SQL
// layer without a real database. Hence integration.
//
// The integration suite is SERIAL — run this file on its own.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember, TeamSettings, User } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels, GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { EventsRpcLive } from '~/rpc/event/index.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const GuildPlainRepositories = Layer.mergeAll(
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  DiscordChannelMappingRepository.Default,
  GroupsRepository.Default,
  InviteAcceptancesRepository.Default,
  PendingGuildJoinsRepository.Default,
  TeamSettingsRepository.Default,
  PersonalEventChannelsRepository.Default,
  PersonalEventOverflowCategoriesRepository.Default,
  EventsRepository.Default,
  SudoSessionsRepository.Default,
);

const EventsPlainRepositories = Layer.mergeAll(
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
);

const RealReposLayer = GuildPlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const EventsRpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(EventRosterProvisioningService.Default),
  Layer.provide(EventsPlainRepositories),
  Layer.provideMerge(TestPgClient),
);

const GuildRpcTestLayer = GuildsRpcLive.pipe(
  Layer.provide(GuildPlainRepositories),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// --- seed helpers -----------------------------------------------------------

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
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const setLock = (
  teamId: Team.TeamId,
  lock: Option.Option<number>,
  overrides: TeamSettings.RsvpLockHoursBeforeOverrides = {},
) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        timezone: 'Europe/Prague',
        rsvpLockHoursBefore: lock,
        rsvpLockHoursBeforeOverrides: overrides,
      }),
    ),
  );

const insertEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  startAt: DateTime.Utc,
  eventType: 'training' | 'tournament' = 'training',
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType,
        title: 'Timed event',
        description: Option.none(),
        startAt,
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
        allDay: false,
      }),
    ),
  );

/** now() + `hours`, asked of Postgres so the `start_at >= now()` half always holds. */
const nowPlusHours = (hours: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(`SELECT (now() + INTERVAL '${hours} hours') AS instant`),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
  );

const callEventProducer = (params: {
  guild_id: Discord.Snowflake;
  discord_user_id: Discord.Snowflake;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/GetUpcomingEventsForUser']({
            guild_id: params.guild_id,
            discord_user_id: params.discord_user_id,
            offset: 0,
            limit: 10,
          }) as Effect.Effect<EventRpcModels.UpcomingEventsForUserResult, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(EventsRpcTestLayer));

const callGuildProducer = (params: {
  guild_id: Discord.Snowflake;
  discord_user_id: Discord.Snowflake;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/GetAllUpcomingEventsForUser']({
            guild_id: params.guild_id,
            discord_user_id: params.discord_user_id,
          }) as Effect.Effect<EventRpcModels.UpcomingEventsForUserResult, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(GuildRpcTestLayer));

const entryFrom = (
  result: Exit.Exit<EventRpcModels.UpcomingEventsForUserResult, unknown>,
  eventId: string,
  label: string,
): EventRpcModels.UpcomingEventForUserEntry => {
  expect(Exit.isSuccess(result), `${label} must succeed`).toBe(true);
  if (!Exit.isSuccess(result)) throw new Error(`${label} failed`);
  const entry = result.value.events.find((e) => e.event_id === eventId);
  expect(entry, `${label} must return the seeded event`).toBeDefined();
  return entry as EventRpcModels.UpcomingEventForUserEntry;
};

/** Seeds a team + member + one event and reads it back from BOTH producers. */
const seedAndReadBoth = (opts: {
  n: string;
  lock: Option.Option<number>;
  overrides?: TeamSettings.RsvpLockHoursBeforeOverrides;
  eventType?: 'training' | 'tournament';
}) =>
  Effect.Do.pipe(
    Effect.let('discordId', () => `4900000000000000${opts.n}` as Discord.Snowflake),
    Effect.bind('user', ({ discordId }) => createUser(discordId, `lock-rpc-${opts.n}`)),
    Effect.bind('team', ({ user }) =>
      createTeam(`4910101010101010${opts.n}` as Discord.Snowflake, user.id),
    ),
    Effect.tap(({ team }) => setLock(team.id, opts.lock, opts.overrides ?? {})),
    Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
    Effect.bind('startAt', () => nowPlusHours(48)),
    Effect.bind('event', ({ team, tm, startAt }) =>
      insertEvent(
        team.id,
        (tm as any).id as TeamMember.TeamMemberId,
        startAt,
        opts.eventType ?? 'training',
      ),
    ),
    Effect.bind('eventResult', ({ team, discordId }) =>
      callEventProducer({ guild_id: team.guild_id, discord_user_id: discordId }),
    ),
    Effect.bind('guildResult', ({ team, discordId }) =>
      callGuildProducer({ guild_id: team.guild_id, discord_user_id: discordId }),
    ),
    Effect.map(({ event, eventResult, guildResult }) => ({
      event,
      fromEventRpc: entryFrom(eventResult, event.id, 'Event/GetUpcomingEventsForUser'),
      fromGuildRpc: entryFrom(guildResult, event.id, 'Guild/GetAllUpcomingEventsForUser'),
    })),
  );

const expectClosesAt = (
  entry: EventRpcModels.UpcomingEventForUserEntry,
  hoursBeforeStart: number,
  label: string,
) => {
  expect(Option.isSome(entry.rsvp_closes_at), `${label}: rsvp_closes_at must be Some`).toBe(true);
  expect(
    DateTime.toEpochMillis(Option.getOrThrow(entry.rsvp_closes_at)),
    `${label}: rsvp_closes_at must equal start_at - ${hoursBeforeStart}h`,
  ).toBe(DateTime.toEpochMillis(entry.start_at) - hoursBeforeStart * 60 * 60 * 1000);
};

// ---------------------------------------------------------------------------

describe('rsvp_closes_at — BOTH producers of UpcomingEventForUserEntry', () => {
  itEffect.effect('case 1+2: a 24h team lock reaches /event list AND the personal-card feed', () =>
    Effect.Do.pipe(
      Effect.bind('r', () => seedAndReadBoth({ n: '01', lock: Option.some(24) })),
      Effect.tap(({ r }) =>
        Effect.sync(() => {
          // case 1 — the /event list producer.
          expectClosesAt(r.fromEventRpc, 24, 'Event/GetUpcomingEventsForUser');
          // case 2 — THE ONE REVISION 1 MISSED. `rpc/guild/index.ts:1658` is the
          // only feed for Discord personal cards.
          expectClosesAt(r.fromGuildRpc, 24, 'Guild/GetAllUpcomingEventsForUser');
          // And they must agree with each other, not merely both be Some.
          expect(DateTime.toEpochMillis(Option.getOrThrow(r.fromGuildRpc.rsvp_closes_at))).toBe(
            DateTime.toEpochMillis(Option.getOrThrow(r.fromEventRpc.rsvp_closes_at)),
          );
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect('case 3: a team with no lock gets None from both', () =>
    Effect.Do.pipe(
      Effect.bind('r', () => seedAndReadBoth({ n: '02', lock: Option.none() })),
      Effect.tap(({ r }) =>
        Effect.sync(() => {
          expect(Option.isNone(r.fromEventRpc.rsvp_closes_at)).toBe(true);
          expect(Option.isNone(r.fromGuildRpc.rsvp_closes_at)).toBe(true);
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect(
    'case 4: per-type OFF ({training: null}) beats a base of 24 at both producers',
    () =>
      Effect.Do.pipe(
        Effect.bind('r', () =>
          seedAndReadBoth({
            n: '03',
            lock: Option.some(24),
            overrides: { training: null },
            eventType: 'training',
          }),
        ),
        Effect.tap(({ r }) =>
          Effect.sync(() => {
            expect(Option.isNone(r.fromEventRpc.rsvp_closes_at)).toBe(true);
            expect(Option.isNone(r.fromGuildRpc.rsvp_closes_at)).toBe(true);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect('a per-type value of 0 closes RSVPs exactly at start, at both producers', () =>
    Effect.Do.pipe(
      Effect.bind('r', () =>
        seedAndReadBoth({
          n: '04',
          lock: Option.some(24),
          overrides: { tournament: 0 },
          eventType: 'tournament',
        }),
      ),
      Effect.tap(({ r }) =>
        Effect.sync(() => {
          expectClosesAt(r.fromEventRpc, 0, 'Event/GetUpcomingEventsForUser');
          expectClosesAt(r.fromGuildRpc, 0, 'Guild/GetAllUpcomingEventsForUser');
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );
});
