import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EarnedAchievementsRepository.Default,
  ActivityLogsRepository.Default,
  ActivityTypesRepository.Default,
  TeamMembersRepository.Default,
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

/**
 * Seeds a global activity type (team_id = NULL) with the given name and slug.
 * Uses raw SQL because ActivityTypesRepository has no insert method.
 * cleanDatabase truncates activity_types, so tests that need seeded types
 * must re-create them via this helper.
 */
const seedActivityType = (name: string, slug: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`INSERT INTO activity_types (team_id, name, slug) VALUES (NULL, ${name}, ${slug}) ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING`,
    ),
    Effect.andThen(() =>
      ActivityTypesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findBySlug(slug)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error(`activity type '${slug}' not found after seeding`)),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EarnedAchievementsRepository', () => {
  it.effect(
    'insertIfMissing returns true on first insert, then false on duplicate; only one row exists',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('400000000000000001', 'achieve-user-1')),
        Effect.bind('team', ({ userId }) =>
          createTeam('401010101010101010' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.bind('firstInsert', ({ tm }) =>
          EarnedAchievementsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertIfMissing(tm.id, 'first_activity')),
          ),
        ),
        Effect.bind('secondInsert', ({ tm }) =>
          EarnedAchievementsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertIfMissing(tm.id, 'first_activity')),
          ),
        ),
        Effect.bind('rows', ({ tm }) =>
          EarnedAchievementsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByMember(tm.id)),
          ),
        ),
        Effect.tap(({ firstInsert, secondInsert, rows }) =>
          Effect.sync(() => {
            expect(firstInsert).toBe(true);
            expect(secondInsert).toBe(false);
            expect(rows).toHaveLength(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('findEarnedSlugs returns Set of slugs after inserts', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('400000000000000002', 'achieve-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('402020202020202020' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ tm }) =>
        EarnedAchievementsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo.insertIfMissing(tm.id, 'first_activity'),
              repo.insertIfMissing(tm.id, 'ten_activities'),
            ]),
          ),
        ),
      ),
      Effect.bind('slugs', ({ tm }) =>
        EarnedAchievementsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEarnedSlugs(tm.id)),
        ),
      ),
      Effect.tap(({ slugs }) =>
        Effect.sync(() => {
          expect(slugs instanceof Set).toBe(true);
          expect(slugs.has('first_activity')).toBe(true);
          expect(slugs.has('ten_activities')).toBe(true);
          expect(slugs.size).toBe(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByMember returns rows with slug and earned_at', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('400000000000000003', 'achieve-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('403030303030303030' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ tm }) =>
        EarnedAchievementsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertIfMissing(tm.id, 'streak_3')),
        ),
      ),
      Effect.bind('rows', ({ tm }) =>
        EarnedAchievementsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByMember(tm.id)),
        ),
      ),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          const row = rows[0];
          expect(row).toBeDefined();
          expect(row?.achievement_slug).toBe('streak_3');
          // earned_at should be present (not null/undefined)
          expect(row?.earned_at).toBeDefined();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'getActivityCountsBySlug returns counts per activity_type slug after seeding activity_logs',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('400000000000000004', 'achieve-user-4')),
        Effect.bind('team', ({ userId }) =>
          createTeam('404040404040404040' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        // Seed global activity types — cleanDatabase truncates activity_types so we must re-create them.
        Effect.bind('gymType', () => seedActivityType('Gym', 'gym')),
        Effect.bind('runningType', () => seedActivityType('Run', 'running')),
        // Insert 3 gym logs and 2 running logs
        Effect.tap(({ tm, gymType }) =>
          ActivityLogsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all([
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: gymType.id,
                  logged_at: new Date('2026-01-01T10:00:00Z'),
                  duration_minutes: Option.some(60),
                  note: Option.none(),
                  source: 'manual',
                }),
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: gymType.id,
                  logged_at: new Date('2026-01-02T10:00:00Z'),
                  duration_minutes: Option.some(60),
                  note: Option.none(),
                  source: 'manual',
                }),
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: gymType.id,
                  logged_at: new Date('2026-01-03T10:00:00Z'),
                  duration_minutes: Option.some(60),
                  note: Option.none(),
                  source: 'manual',
                }),
              ]),
            ),
          ),
        ),
        Effect.tap(({ tm, runningType }) =>
          ActivityLogsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all([
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: runningType.id,
                  logged_at: new Date('2026-01-04T10:00:00Z'),
                  duration_minutes: Option.some(30),
                  note: Option.none(),
                  source: 'manual',
                }),
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: runningType.id,
                  logged_at: new Date('2026-01-05T10:00:00Z'),
                  duration_minutes: Option.some(30),
                  note: Option.none(),
                  source: 'manual',
                }),
              ]),
            ),
          ),
        ),
        Effect.bind('counts', ({ tm }) =>
          EarnedAchievementsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getActivityCountsBySlug(tm.id)),
          ),
        ),
        Effect.tap(({ counts }) =>
          Effect.sync(() => {
            const gymCount = counts.find((c: { slug: string; count: number }) => c.slug === 'gym');
            const runningCount = counts.find(
              (c: { slug: string; count: number }) => c.slug === 'running',
            );
            expect(gymCount).toBeDefined();
            expect(gymCount?.count).toBe(3);
            expect(runningCount).toBeDefined();
            expect(runningCount?.count).toBe(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('getActivityCountsBySlug returns empty array for member with no activities', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('400000000000000005', 'achieve-user-5')),
      Effect.bind('team', ({ userId }) =>
        createTeam('405050505050505050' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('counts', ({ tm }) =>
        EarnedAchievementsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getActivityCountsBySlug(tm.id)),
        ),
      ),
      Effect.tap(({ counts }) =>
        Effect.sync(() => {
          expect(counts).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
