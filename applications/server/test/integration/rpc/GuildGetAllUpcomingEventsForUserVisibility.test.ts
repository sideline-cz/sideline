// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7c / §7.7g of the
// test spec; §4.4/§14.1, §4.4.2's GROUP BY hazard, §4.7/§14.3's day-grouped
// ordering).
//
// `Guild/GetAllUpcomingEventsForUser` is the query
// `applications/bot/src/rcp/personalEvents/handleReconcile.ts` calls for every
// member on every reconcile — "the one that matters most" per the plan's PR 4
// task list, since the `entry === undefined` branch there is what deletes a
// member's personal message. A mocked `SqlClient` cannot exercise the real
// GROUP BY/predicate; this file wires the real `GuildsRpcLive` against a real
// Postgres (testcontainers), the same pattern as
// `EventGetUpcomingEventsForUserAllDayDate.test.ts` / …Visibility.test.ts.
//
// Expected to FAIL until the developer relaxes the predicate (status IN
// ('active','started') + "+1 local day" instant math for all-day) and adds
// `eventDayOrder` to the ORDER BY (GROUP BY already carries `ts.timezone`,
// added in PR 3b — the join itself is not new here, only the WHERE/ORDER BY).

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { type EventRpcModels, GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const PlainRepositories = Layer.mergeAll(
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  DiscordRoleMappingRepository.Default,
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

const RealReposLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const RpcTestLayer = GuildsRpcLive.pipe(
  Layer.provide(PlainRepositories),
  Layer.provideMerge(TestPgClient),
);

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
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const setTeamTimezone = (teamId: Team.TeamId, timezone: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        timezone,
      }),
    ),
  );

const insertEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  allDay: boolean,
  startAt: DateTime.Utc,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: allDay ? 'All-day event' : 'Timed event',
        description: Option.none(),
        startAt,
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
        allDay,
      }),
    ),
  );

const setStatus = (eventId: string, status: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET status = '${status}' WHERE id = '${eventId}'`),
    ),
  );

const localMidnight = (tz: string, dayOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(
        `SELECT (((now() AT TIME ZONE '${tz}')::date + ${dayOffset}) AT TIME ZONE '${tz}') AS instant`,
      ),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
  );

const callGetAllUpcomingEventsForUser = (params: {
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
  ).pipe(Effect.provide(RpcTestLayer));

describe('Guild/GetAllUpcomingEventsForUser — visibility relaxation (PR 4)', () => {
  itEffect.effect(
    'all-day, status=started, still its own local day → returned (this is the query handleReconcile calls)',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '480000000000000001' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'vis-guild-rpc-1')),
        Effect.bind('team', ({ user }) =>
          createTeam('481010101010101011' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, tm, start }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true, start),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('result', ({ team, discordId }) =>
          callGetAllUpcomingEventsForUser({
            guild_id: team.guild_id,
            discord_user_id: discordId,
          }),
        ),
        Effect.tap(({ result, event }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              expect(result.value.events.some((e) => e.event_id === event.id)).toBe(true);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'all-day, last local day already passed → NOT returned (so handleReconcile takes the delete branch)',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '480000000000000002' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'vis-guild-rpc-2')),
        Effect.bind('team', ({ user }) =>
          createTeam('481010101010101012' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, tm, start }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true, start),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('result', ({ team, discordId }) =>
          callGetAllUpcomingEventsForUser({
            guild_id: team.guild_id,
            discord_user_id: discordId,
          }),
        ),
        Effect.tap(({ result, event }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              expect(result.value.events.some((e) => e.event_id === event.id)).toBe(false);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
