// TDD mode — PR 3b of the all-day-Discord-start-time plan.
//
// `Event/GetUpcomingEventsForUser` (applications/server/src/rpc/event/index.ts) is the
// query that feeds `UpcomingEventForUserEntry` — the payload behind
// `buildUpcomingEventEmbed` (row B0 of the plan's §11.1 audit), the highest-volume
// all-day render in the product (personal-channel embed, `/event upcoming`, and the
// upcoming-RSVP re-render).
//
// This query is `GROUP BY e.id, my_rsvp.response, my_rsvp.message` — an AGGREGATE
// query. Adding `LEFT JOIN team_settings ts ON ts.team_id = e.team_id` and selecting
// `(e.start_at AT TIME ZONE COALESCE(ts.timezone,'Europe/Prague'))::date::text` from it
// requires `ts`'s grouping column to ALSO be added to `GROUP BY` — otherwise Postgres
// raises `42803` ("column must appear in the GROUP BY clause or be used in an
// aggregate function"), which surfaces as a `SqlError`.
//
// Per the plan: a row-mapping assertion never reaches that error — only actually
// EXECUTING the query does. And per the plan's most concrete warning: a `SchemaError`
// (the `::date` cast returning a JS `Date` instead of a string is the other way this
// query can break) reaches the bot as an `RpcClientError`, which
// `reorderPersonalChannel.ts:173` silently swallows into `[]` — personal channels
// would stop reordering with NO error anywhere. `Exit.isSuccess` is therefore the
// load-bearing assertion in this file, not a formality.
//
// These tests are expected to fail (or the RPC call to error) until the developer
// implements the join + projection + GROUP BY fix described above.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
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

// ---------------------------------------------------------------------------
// Real repository layer, over a real Postgres (testcontainers) — this is a raw-SQL
// RPC handler, so a mock SqlClient cannot exercise the real query planner and can't
// catch a GROUP BY / cast mistake (see file header).
//
// `EventRosterProvisioningService.Default` itself REQUIRES several of the plain
// repositories below (EventRostersRepository, RostersRepository, etc.) — a sibling
// dependency, not just SqlClient. `Layer.mergeAll` builds its members against the
// SAME shared input context, in parallel; it does NOT thread one merged member's
// output to satisfy another member's requirement. Throwing the service layer into
// the same `mergeAll` as its own dependencies reproduces exactly the "Service not
// found: api/EventRostersRepository" defect this file's tests are meant to guard
// against reappearing — so this file mirrors AppLive.ts's real composition order:
// provide the service layer FIRST (closest to the RPC layer), then provide the
// flat repository mergeAll to satisfy everyone's remaining requirements, then
// finally the real Postgres client.
// ---------------------------------------------------------------------------

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

// Used by this file's seed helpers (createUser/createTeam/addTeamMember/etc.), none
// of which touch EventRosterProvisioningService.
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

// Far-future date so `e.start_at >= now()` holds for the life of this suite, and
// noon-UTC so the current sentinel is still in effect (anchor-neutral, §17).
const FUTURE_ALL_DAY_START = '2099-07-15T12:00:00Z';

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
        eventHorizonDays: 14,
        minPlayersThreshold: 0,
        timezone,
      }),
    ),
  );

const insertFutureAllDayEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: 'Upcoming all-day tournament',
        description: Option.none(),
        startAt: DateTime.makeUnsafe(FUTURE_ALL_DAY_START),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
        allDay: true,
      }),
    ),
  );

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
            limit: 10,
          }) as Effect.Effect<EventRpcModels.UpcomingEventsForUserResult, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

describe('Event/GetUpcomingEventsForUser — start_date/end_date derived projection (PR 3b)', () => {
  // Item 7 — the query gains a joined column on a query that GROUPs BY e.id. Assert
  // the RPC call actually EXECUTES (Exit.isSuccess), not just that a row, if returned,
  // maps correctly — a 42803 SqlError never reaches a row-mapping assertion.
  itEffect.effect(
    'executes successfully (no 42803) for a team WITH a team_settings row, and returns a matching start_date',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '320000000000000001' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'upcoming-user-1')),
        Effect.bind('team', ({ user }) =>
          createTeam('321010101010101011' as Discord.Snowflake, user.id),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'America/New_York')),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.tap(({ team, tm }) =>
          insertFutureAllDayEvent(team.id, (tm as any).id as TeamMember.TeamMemberId),
        ),
        Effect.bind('result', ({ team, discordId }) =>
          callGetUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              const entry = result.value.events[0];
              expect(entry).toBeDefined();
              expect(Option.isSome(entry.start_date)).toBe(true);
              expect(Option.getOrThrow(entry.start_date)).toMatch(DATE_ONLY_RE);
              // Noon UTC = 08:00 America/New_York — same calendar date, anchor-neutral.
              expect(Option.getOrThrow(entry.start_date)).toBe('2099-07-15');
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  // Item 3 (for this specific query) — a team with no team_settings row must not
  // 42803 out, and must not silently drop the event from the result.
  itEffect.effect(
    'executes successfully for a team with NO team_settings row, and the event is not dropped',
    () =>
      Effect.Do.pipe(
        Effect.let('discordId', () => '320000000000000002' as Discord.Snowflake),
        Effect.bind('user', ({ discordId }) => createUser(discordId, 'upcoming-user-2')),
        Effect.bind('team', ({ user }) =>
          createTeam('321010101010101012' as Discord.Snowflake, user.id),
        ),
        // Deliberately no setTeamTimezone call — no team_settings row exists.
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.tap(({ team, tm }) =>
          insertFutureAllDayEvent(team.id, (tm as any).id as TeamMember.TeamMemberId),
        ),
        Effect.bind('result', ({ team, discordId }) =>
          callGetUpcomingEventsForUser({ guild_id: team.guild_id, discord_user_id: discordId }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result)) {
              // Not dropped — an inner join (or `UPDATE ... FROM team_settings`-style
              // exclusion) would exclude the row instead of falling back.
              expect(result.value.events.length).toBe(1);
              const entry = result.value.events[0];
              expect(Option.isSome(entry.start_date)).toBe(true);
              // Europe/Prague fallback: noon UTC = 14:00 Prague, same calendar date.
              expect(Option.getOrThrow(entry.start_date)).toBe('2099-07-15');
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
