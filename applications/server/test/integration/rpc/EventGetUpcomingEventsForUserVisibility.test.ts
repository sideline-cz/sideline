// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7c / §7.7g of the
// test spec; §4.4/§14.1 for the shared visibility fragment, §4.4.2 for the
// GROUP BY 42803 hazard — already mitigated for THIS query by PR 3b's
// `ts.timezone` join/group-by, but the WHERE-clause relaxation and the
// `eventDayOrder` ORDER BY are new in PR 4 — §4.7/§14.3 for day-grouped
// ordering, §4.4.3 for the `id` pagination tiebreaker, §9.35 of PR 4's task
// list item 4.5 for the new `status` field on `UpcomingEventForUserEntry`).
//
// Mirrors the real-Postgres RPC wiring established in
// `EventGetUpcomingEventsForUserAllDayDate.test.ts` (PR 3b) — a raw-SQL RPC
// handler needs a real Postgres to catch a GROUP BY / predicate mistake; a
// mocked `SqlClient` cannot.
//
// Expected to FAIL until the developer relaxes the predicate (status IN
// ('active','started') + "+1 local day" instant math for all-day), adds
// `eventDayOrder` to ORDER BY, and adds `status` to the entry / SELECT.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
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
);

const RealReposLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(EventRosterProvisioningService.Default),
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

/** Team-local midnight of (today + dayOffset), asked of Postgres itself. */
const localMidnight = (tz: string, dayOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(
        `SELECT (((now() AT TIME ZONE '${tz}')::date + ${dayOffset}) AT TIME ZONE '${tz}') AS instant`,
      ),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
  );

/** now() + `hours` — used for "future today" timed fixtures so the
 * `e.start_at >= now()` half of the predicate is always satisfied regardless
 * of when the suite runs. */
const nowPlusHours = (hours: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(`SELECT (now() + INTERVAL '${hours} hours') AS instant`),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
  );

const callGetUpcomingEventsForUser = (params: {
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
            limit: 50,
          }) as Effect.Effect<EventRpcModels.UpcomingEventsForUserResult, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

describe('Event/GetUpcomingEventsForUser — visibility relaxation (PR 4)', () => {
  itEffect.effect(
    'all-day event, status=started, still its own local day → returned; page total agrees with count',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '470000000000000001' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'vis-rpc-1')),
        Effect.bind('team', ({ user }) =>
          createTeam('471010101010101011' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, tm, start }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true, start),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('result', ({ team, discordId }) =>
          callGetUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result, event }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              const entry = result.value.events.find((e) => e.event_id === event.id);
              expect(entry).toBeDefined();
              // total (from the separate COUNT query) must agree with the page
              // when the whole result fits on one page — a desync here means the
              // page and count predicates drifted apart (BL2's exact failure mode).
              expect(result.value.total).toBe(result.value.events.length);
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect('all-day, status=cancelled, same local day → NOT returned', () =>
    Effect.Do.pipe(
      Effect.let('discordId', () => '470000000000000002' as Discord.Snowflake),
      Effect.bind('user', ({ discordId }) => createUser(discordId, 'vis-rpc-2')),
      Effect.bind('team', ({ user }) =>
        createTeam('471010101010101012' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
      Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
      Effect.bind('event', ({ team, tm, start }) =>
        insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true, start),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'cancelled')),
      Effect.bind('result', ({ team, discordId }) =>
        callGetUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
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

  itEffect.effect(
    'V3 ordering: all-day (today) sorts before two timed-today events, which sort before a timed-tomorrow event',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '470000000000000003' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'vis-rpc-3')),
        Effect.bind('team', ({ user }) =>
          createTeam('471010101010101013' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('allDayStart', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('allDayEvent', ({ team, tm, allDayStart }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true, allDayStart),
        ),
        Effect.tap(({ allDayEvent }) => setStatus(allDayEvent.id, 'started')),
        Effect.bind('soonStart', () => nowPlusHours(2)),
        Effect.bind('soonEvent', ({ team, tm, soonStart }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, false, soonStart),
        ),
        Effect.bind('laterStart', () => nowPlusHours(4)),
        Effect.bind('laterEvent', ({ team, tm, laterStart }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, false, laterStart),
        ),
        Effect.bind('tomorrowStart', () => nowPlusHours(30)),
        Effect.bind('tomorrowEvent', ({ team, tm, tomorrowStart }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, false, tomorrowStart),
        ),
        Effect.bind('result', ({ team, discordId }) =>
          callGetUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result, allDayEvent, soonEvent, laterEvent, tomorrowEvent }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (!Exit.isSuccess(result)) return;
            const ids = result.value.events.map((e) => e.event_id);
            expect(ids).toEqual([allDayEvent.id, soonEvent.id, laterEvent.id, tomorrowEvent.id]);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
