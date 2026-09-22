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
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
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

// Nastavitelná docházka (plan §10.2, item 10): a second RPC composition, for
// `Event/GetUpcomingEventsForUser` (the /event list surface — the SIBLING of
// `Guild/GetAllUpcomingEventsForUser` that plan §5.3 says must carry
// `show_attendee_list` too, since it rides on the shared
// `UpcomingEventsForUserResult` wrapper).
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

const EventsRpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(EventRosterProvisioningService.Default),
  Layer.provide(EventsPlainRepositories),
  Layer.provideMerge(TestPgClient),
);

const callGetUpcomingEventsForUserRpc = (params: {
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

const setShowAttendeeList = (memberId: TeamMember.TeamMemberId, value: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET show_attendee_list = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

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

// ---------------------------------------------------------------------------
// Nastavitelná docházka (plan §5.3, §6.3, §10.2, item 10). `show_attendee_list`
// rides on the shared `UpcomingEventsForUserResult` wrapper, so BOTH
// `Guild/GetAllUpcomingEventsForUser` (handleReconcile's query) and
// `Event/GetUpcomingEventsForUser` (the /event list slash command's query,
// `commands/event/list.ts:58`) must carry it. Wiring only the Guild/ handler
// would leave a member who hid the attendee list still seeing every name the
// moment they run /event list — a real user-visible gap, not a hypothetical.
// ---------------------------------------------------------------------------

describe('show_attendee_list rides on UpcomingEventsForUserResult — both RPC siblings carry it', () => {
  itEffect.effect(
    "Guild/GetAllUpcomingEventsForUser carries show_attendee_list matching the member's row",
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '482000000000000001' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'attendee-flag-guild')),
        Effect.bind('team', ({ user }) =>
          createTeam('482010101010101011' as Discord.Snowflake, user.id),
        ),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.tap(({ tm }) =>
          setShowAttendeeList((tm as any).id as TeamMember.TeamMemberId, false),
        ),
        Effect.bind('result', ({ team, discordId }) =>
          callGetAllUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              expect((result.value as any).show_attendee_list).toBe(false);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'Event/GetUpcomingEventsForUser (the /event list RPC) ALSO carries show_attendee_list',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '482000000000000002' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'attendee-flag-event')),
        Effect.bind('team', ({ user }) =>
          createTeam('482010101010101012' as Discord.Snowflake, user.id),
        ),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.tap(({ tm }) =>
          setShowAttendeeList((tm as any).id as TeamMember.TeamMemberId, false),
        ),
        Effect.bind('result', ({ team, discordId }) =>
          callGetUpcomingEventsForUserRpc({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              expect((result.value as any).show_attendee_list).toBe(false);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'a member who did NOT hide the list reads show_attendee_list: true on both RPCs (default)',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '482000000000000003' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'attendee-flag-default')),
        Effect.bind('team', ({ user }) =>
          createTeam('482010101010101013' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('guildResult', ({ team, discordId }) =>
          callGetAllUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.bind('eventResult', ({ team, discordId }) =>
          callGetUpcomingEventsForUserRpc({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ guildResult, eventResult }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(guildResult)).toBe(true);
            expect(Exit.isSuccess(eventResult)).toBe(true);
            if (Exit.isSuccess(guildResult)) {
              expect((guildResult.value as any).show_attendee_list).toBe(true);
            }
            if (Exit.isSuccess(eventResult)) {
              expect((eventResult.value as any).show_attendee_list).toBe(true);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
