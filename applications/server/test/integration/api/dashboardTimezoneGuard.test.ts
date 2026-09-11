// S3 review finding — plan §11.5(c) / §14.5.
//
// `applications/server/src/api/dashboard.ts` computed `todayLocalDate` with
// `new Intl.DateTimeFormat({ timeZone })` fed directly from
// `team_settings.timezone` — free-form `TEXT` with no CHECK constraint (same
// caveat `api/event.ts`'s `resolveZoned` and `utils/allDayRsvpWindow.ts`'s
// `endOfLastLocalDay` already guard against). `Intl.DateTimeFormat` throws a
// `RangeError` on an invalid IANA zone id, which inside an `Effect.map` is a
// DEFECT, not a typed failure — the whole team dashboard 500s.
//
// The fix validates the stored timezone with `DateTime.zoneMakeNamed` first
// and falls back to `'Europe/Prague'`, the same literal the column default
// and every sibling guard use.
//
// This is a Postgres integration test (testcontainers) — it needs a REAL,
// unconstrained `team_settings.timezone` column to write an invalid IANA id
// into, which a mock repository would just accept as an opaque string
// without ever exercising `Intl.DateTimeFormat`'s validation behaviour.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DashboardApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { DashboardApiLive } from '~/api/dashboard.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// See `teamSettingsReanchor.test.ts`/`eventAllDayAnchor.test.ts` for why a
// `SmallApi` containing only the group under test is sufficient.
const SmallApi = HttpApi.make('api').add(DashboardApi.DashboardApiGroup);

let sessionsStore: Map<string, User.UserId>;

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as any);

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  TeamSettingsRepository.Default,
  EventsRepository.Default,
  GroupsRepository.Default,
  LeaderboardRepository.Default,
  ActivityLogsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(DashboardApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

// A separate layer instance for direct repository access (seeding), same
// underlying Postgres, no HTTP involved.
const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
});

// ---------------------------------------------------------------------------
// Seeding helpers (mirrors teamSettingsReanchor.test.ts's pattern)
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
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
        name: 'Dashboard Timezone Guard Team',
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

const addAdminMember = (teamId: Team.TeamId, userId: User.UserId) =>
  Effect.Do.pipe(
    Effect.bind('tm', () =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
        ),
      ),
    ),
    Effect.tap(() =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
      ),
    ),
    Effect.bind('adminRole', () =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Admin')),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error('Admin role not found')),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ tm, adminRole }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRole((tm as any).id, adminRole.id)),
      ),
    ),
    Effect.map(({ tm }) => (tm as any).id as TeamMember.TeamMemberId),
  );

// Mirrors `formatDateInTimeZone` (`api/dashboard.ts`) — the LOCAL calendar
// date in `zoneId`, as `YYYY-MM-DD`. Deliberately independent of
// `DateTime.formatIsoDateUtc`, which always reads the UTC date regardless of
// the value's own zone.
const localDateString = (zoneId: string): string => {
  const zoned = DateTime.setZoneNamedUnsafe(DateTime.nowUnsafe(), zoneId);
  const { year, month, day } = DateTime.toParts(zoned);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
};

const HOST = 'http://localhost';

const getDashboard = (teamId: Team.TeamId) =>
  handler(
    new Request(`${HOST}/teams/${teamId}/dashboard`, {
      headers: { Authorization: 'Bearer admin-token' },
    }),
  );

const setup = (guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('ownerId', () => createUser(guildId, `owner-${guildId}`)),
    Effect.bind('team', ({ ownerId }) => createTeam(guildId, ownerId)),
    Effect.bind('memberId', ({ team, ownerId }) => addAdminMember(team.id, ownerId)),
    Effect.tap(({ ownerId }) => Effect.sync(() => sessionsStore.set('admin-token', ownerId))),
    Effect.map(({ team, memberId }) => ({ teamId: team.id, memberId })),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard survives an invalid stored team timezone (S3, plan §11.5(c))', () => {
  it.effect('returns 200 with the Europe/Prague fallback date instead of 500ing', () =>
    Effect.gen(function* () {
      const guildId = '340000000000000001' as Discord.Snowflake;
      const { teamId } = yield* Effect.promise(() => setup(guildId));

      // Bypasses the web's own IANA-id validation — exactly the "operator
      // write" / "seed" / "migration" scenario the column's missing CHECK
      // constraint leaves reachable in production.
      yield* TeamSettingsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.upsert({
            teamId,
            eventHorizonDays: 14,
            minPlayersThreshold: 0,
            timezone: 'Not/AZone',
          }),
        ),
      );

      const response = yield* Effect.promise(() => getDashboard(teamId));
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.json());

      expect(body.todayLocalDate).toBe(localDateString('Europe/Prague'));
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('returns 200 with the team-local date for a VALID stored timezone', () =>
    Effect.gen(function* () {
      const guildId = '340000000000000002' as Discord.Snowflake;
      const { teamId } = yield* Effect.promise(() => setup(guildId));

      yield* TeamSettingsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.upsert({
            teamId,
            eventHorizonDays: 14,
            minPlayersThreshold: 0,
            timezone: 'Asia/Tokyo',
          }),
        ),
      );

      const response = yield* Effect.promise(() => getDashboard(teamId));
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.json());

      expect(body.todayLocalDate).toBe(localDateString('Asia/Tokyo'));
    }).pipe(Effect.provide(SeedLayer)),
  );
});
