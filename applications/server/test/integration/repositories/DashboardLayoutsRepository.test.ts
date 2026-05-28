// TDD mode — tests written BEFORE the DashboardLayoutsRepository implementation exists.
// These tests WILL FAIL until the developer implements:
//   applications/server/src/repositories/DashboardLayoutsRepository.ts
//
// Required implementation:
//   - DashboardLayoutsRepository service with:
//       findByUserTeam(userId: User.UserId, teamId: Team.TeamId): Effect<Option<{widgets: ...}>>
//       upsert(userId: User.UserId, teamId: Team.TeamId, widgets: ReadonlyArray<DashboardWidget>): Effect<{widgets: ...}>

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DashboardLayoutApi } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { DashboardLayoutsRepository } from '~/repositories/DashboardLayoutsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  DashboardLayoutsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
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
        name: 'Dashboard Test Team',
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
        overview_channel_id: Option.none(),
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

const makeWidgets = (): ReadonlyArray<DashboardLayoutApi.DashboardWidget> =>
  DashboardLayoutApi.DEFAULT_LAYOUT.map(
    (entry) =>
      new DashboardLayoutApi.DashboardWidget({
        id: entry.id,
        visible: entry.visible,
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
      }),
  );

const makePartialWidgets = (): ReadonlyArray<DashboardLayoutApi.DashboardWidget> => [
  new DashboardLayoutApi.DashboardWidget({
    id: 'teamManagement',
    visible: false,
    x: 8,
    y: 4,
    w: 4,
    h: 2,
  }),
  new DashboardLayoutApi.DashboardWidget({ id: 'stats', visible: true, x: 0, y: 0, w: 12, h: 2 }),
];

// ---------------------------------------------------------------------------
// findByUserTeam — no row
// ---------------------------------------------------------------------------

describe('DashboardLayoutsRepository — findByUserTeam with no row', () => {
  it.effect('returns Option.none when no row exists for user+team', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('810000000000000001', 'dash-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('810100000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('found', ({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// upsert then findByUserTeam — round-trip
// ---------------------------------------------------------------------------

describe('DashboardLayoutsRepository — upsert then findByUserTeam', () => {
  it.effect('upsert then findByUserTeam → Option.some with exact widgets array', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('810000000000000002', 'dash-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('810200000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('widgets', () => Effect.succeed(makeWidgets())),
      Effect.tap(({ userId, team, widgets }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsert(userId, team.id as Team.TeamId, widgets)),
        ),
      ),
      Effect.bind('found', ({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ found, widgets }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(row.widgets).toHaveLength(widgets.length);
          for (let i = 0; i < widgets.length; i++) {
            expect(row.widgets[i].id).toBe(widgets[i].id);
            expect(row.widgets[i].visible).toBe(widgets[i].visible);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// upsert twice — reflects update
// ---------------------------------------------------------------------------

describe('DashboardLayoutsRepository — upsert twice reflects update', () => {
  it.effect('second upsert overwrites the first', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('810000000000000003', 'dash-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('810300000000000000' as Discord.Snowflake, userId),
      ),
      // First upsert — all visible
      Effect.tap(({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsert(userId, team.id as Team.TeamId, makeWidgets())),
        ),
      ),
      // Second upsert — partial/different
      Effect.tap(({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(userId, team.id as Team.TeamId, makePartialWidgets()),
          ),
        ),
      ),
      Effect.bind('found', ({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          // Reflects the second upsert (partial)
          expect(row.widgets).toHaveLength(makePartialWidgets().length);
          expect(row.widgets[0].id).toBe('teamManagement');
          expect(row.widgets[0].visible).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Two users same team are independent
// ---------------------------------------------------------------------------

describe('DashboardLayoutsRepository — two users same team are independent', () => {
  it.effect('user1 layout does not affect user2 layout for the same team', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('810000000000000004', 'dash-user-4a')),
      Effect.bind('userId2', () => createUser('810000000000000005', 'dash-user-4b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('810400000000000000' as Discord.Snowflake, userId1),
      ),
      // Upsert for user1 with full widgets
      Effect.tap(({ userId1, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsert(userId1, team.id as Team.TeamId, makeWidgets())),
        ),
      ),
      // Upsert for user2 with partial widgets
      Effect.tap(({ userId2, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(userId2, team.id as Team.TeamId, makePartialWidgets()),
          ),
        ),
      ),
      Effect.bind('found1', ({ userId1, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId1, team.id as Team.TeamId)),
        ),
      ),
      Effect.bind('found2', ({ userId2, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId2, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ found1, found2 }) =>
        Effect.sync(() => {
          expect(Option.isSome(found1)).toBe(true);
          expect(Option.isSome(found2)).toBe(true);
          const row1 = Option.getOrThrow(found1);
          const row2 = Option.getOrThrow(found2);
          // User1 has full widgets, user2 has partial
          expect(row1.widgets).toHaveLength(makeWidgets().length);
          expect(row2.widgets).toHaveLength(makePartialWidgets().length);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// CASCADE: deleting team removes the row
// ---------------------------------------------------------------------------

describe('DashboardLayoutsRepository — CASCADE on team delete', () => {
  it.effect('deleting the team removes the dashboard layout row', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('810000000000000006', 'dash-user-5')),
      Effect.bind('team', ({ userId }) =>
        createTeam('810500000000000000' as Discord.Snowflake, userId),
      ),
      Effect.tap(({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsert(userId, team.id as Team.TeamId, makeWidgets())),
        ),
      ),
      // Verify row exists before deletion
      Effect.bind('before', ({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ before }) =>
        Effect.sync(() => {
          expect(Option.isSome(before)).toBe(true);
        }),
      ),
      // Delete the team via raw SQL to trigger CASCADE on dashboard_layouts
      Effect.tap(({ team }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) => sql`DELETE FROM teams WHERE id = ${team.id}`),
        ),
      ),
      // After cascade, the layout row should be gone
      Effect.bind('after', ({ userId, team }) =>
        DashboardLayoutsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByUserTeam(userId, team.id as Team.TeamId)),
        ),
      ),
      Effect.tap(({ after }) =>
        Effect.sync(() => {
          expect(Option.isNone(after)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
