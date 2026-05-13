import { describe, expect, it } from '@effect/vitest';
import type { ActivityType, Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option, Result } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import {
  type ActivityTypeRow,
  ActivityTypesRepository,
} from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  ActivityTypesRepository.Default,
  ActivityLogsRepository.Default,
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
 * Seed global activity types (team_id = NULL) that are cleared by cleanDatabase.
 * Global types have slug set.
 */
const seedGlobalTypes = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`
          INSERT INTO activity_types (team_id, name, slug)
          VALUES
            (NULL, 'Gym', 'gym'),
            (NULL, 'Running', 'running'),
            (NULL, 'Stretching', 'stretching'),
            (NULL, 'Training', 'training')
          ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING
        `,
    ),
    Effect.asVoid,
  );

const getGlobalTypeId = (slug: string) =>
  ActivityTypesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findBySlug(slug)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(`Global type '${slug}' not found`)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.map((t) => t.id),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityTypesRepository', () => {
  describe('findByTeamId', () => {
    it.effect('returns only globals (4 rows) when team has no custom types', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('userId', () => createUser('500000000000000001', 'at-user-1')),
        Effect.bind('team', ({ userId }) =>
          createTeam('501010101010101010' as Discord.Snowflake, userId),
        ),
        Effect.bind('types', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ types }) =>
          Effect.sync(() => {
            expect(types).toHaveLength(4);
            expect(types.every((t: { slug: Option.Option<string> }) => Option.isSome(t.slug))).toBe(
              true,
            );
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('returns globals + custom types with usageCount populated correctly', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('userId', () => createUser('500000000000000002', 'at-user-2')),
        Effect.bind('team', ({ userId }) =>
          createTeam('502020202020202020' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        // Insert a custom type
        Effect.bind('customType', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team.id,
                name: 'MyCustomActivity',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
          ),
        ),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        // Insert one log against the custom type
        Effect.tap(({ tm, customType }) =>
          ActivityLogsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insert({
                team_member_id: tm.id,
                activity_type_id: customType.id,
                logged_at: new Date('2026-01-01T10:00:00Z'),
                duration_minutes: Option.none(),
                note: Option.none(),
                source: 'manual',
              }),
            ),
          ),
        ),
        Effect.bind('types', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ types, customType }) =>
          Effect.sync(() => {
            // 4 globals + 1 custom
            expect(types).toHaveLength(5);
            const custom = (types as Array<{ id: string; usageCount: number }>).find(
              (t) => t.id === customType.id,
            );
            expect(custom).toBeDefined();
            expect(custom?.usageCount).toBe(1);
            const gym = (
              types as Array<{ id: string; usageCount: number; slug?: Option.Option<string> }>
            ).find(
              (t) =>
                Option.isSome(t.slug as Option.Option<string>) &&
                Option.getOrNull(t.slug as Option.Option<string>) === 'gym',
            );
            expect(gym?.usageCount).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('findByIdScoped', () => {
    it.effect('returns the global row when queried with any teamId', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('userId', () => createUser('500000000000000003', 'at-user-3')),
        Effect.bind('team', ({ userId }) =>
          createTeam('503030303030303030' as Discord.Snowflake, userId),
        ),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        Effect.bind('found', ({ gymId, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              // findByIdScoped does not exist yet — expected to fail until implemented
              repo.findByIdScoped(gymId, team.id),
            ),
          ),
        ),
        Effect.tap(({ found, gymId }) =>
          Effect.sync(() => {
            expect(Option.isSome(found)).toBe(true);
            const foundRow = found as Option.Option<ActivityTypeRow>;
            if (Option.isSome(foundRow)) {
              expect(foundRow.value.id).toBe(gymId);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect(
      "returns Option.none when querying another team's custom type (tenant isolation)",
      () =>
        Effect.Do.pipe(
          Effect.tap(() => seedGlobalTypes()),
          Effect.bind('userId', () => createUser('500000000000000004', 'at-user-4')),
          Effect.bind('team1', ({ userId }) =>
            createTeam('504040404040404040' as Discord.Snowflake, userId),
          ),
          Effect.bind('team2', ({ userId }) =>
            createTeam('504040404040404041' as Discord.Snowflake, userId),
          ),
          // Create a custom type for team1
          Effect.bind('customForTeam1', ({ team1 }) =>
            ActivityTypesRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.insertCustom({
                  team_id: team1.id,
                  name: 'Team1Activity',
                  emoji: Option.none(),
                  description: Option.none(),
                }),
              ),
            ),
          ),
          // Query that type ID as if we're team2
          Effect.bind('found', ({ customForTeam1, team2 }) =>
            ActivityTypesRepository.asEffect().pipe(
              Effect.andThen((repo) => repo.findByIdScoped(customForTeam1.id, team2.id)),
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

  describe('insertCustom', () => {
    it.effect('creates a team-scoped row with team_id set and slug null', () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000005', 'at-user-5')),
        Effect.bind('team', ({ userId }) =>
          createTeam('505050505050505050' as Discord.Snowflake, userId),
        ),
        Effect.bind('created', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team.id,
                name: 'CrossFit',
                emoji: Option.some('🏋' as ActivityType.ActivityTypeEmoji),
                description: Option.some(
                  'Functional fitness training' as ActivityType.ActivityTypeDescription,
                ),
              }),
            ),
          ),
        ),
        Effect.tap(({ created, team }) =>
          Effect.sync(() => {
            expect(created.id).toBeDefined();
            expect(created.name).toBe('CrossFit');
            // team_id must be set
            expect(Option.isSome(created.team_id)).toBe(true);
            if (Option.isSome(created.team_id)) {
              expect(created.team_id.value).toBe(team.id);
            }
            // slug should be null/none for custom types
            expect(Option.isNone(created.slug)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect(
      'rejects duplicate name within the same team — maps to ActivityTypeNameAlreadyTakenError',
      () =>
        Effect.Do.pipe(
          Effect.bind('userId', () => createUser('500000000000000006', 'at-user-6')),
          Effect.bind('team', ({ userId }) =>
            createTeam('506060606060606060' as Discord.Snowflake, userId),
          ),
          Effect.tap(({ team }) =>
            ActivityTypesRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.insertCustom({
                  team_id: team.id,
                  name: 'Swimming',
                  emoji: Option.none(),
                  description: Option.none(),
                }),
              ),
            ),
          ),
          // Second insert with same name in same team should fail
          Effect.bind('result', ({ team }) =>
            ActivityTypesRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.insertCustom({
                  team_id: team.id,
                  name: 'Swimming',
                  emoji: Option.none(),
                  description: Option.none(),
                }),
              ),
              Effect.result,
            ),
          ),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              // Should fail with ActivityTypeNameAlreadyTaken error
              expect(result._tag).toBe('Failure');
              if (Result.isFailure(result)) {
                expect((result.failure as any)._tag).toBe('ActivityTypeNameAlreadyTaken');
              }
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect('rejects name that case-insensitively matches a global (e.g. "Gym" vs "gym")', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('userId', () => createUser('500000000000000007', 'at-user-7')),
        Effect.bind('team', ({ userId }) =>
          createTeam('507070707070707070' as Discord.Snowflake, userId),
        ),
        Effect.bind('result', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team.id,
                name: 'Gym',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
            Effect.result,
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('allows the same name across different teams', () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000008', 'at-user-8')),
        Effect.bind('team1', ({ userId }) =>
          createTeam('508080808080808080' as Discord.Snowflake, userId),
        ),
        Effect.bind('team2', ({ userId }) =>
          createTeam('508080808080808081' as Discord.Snowflake, userId),
        ),
        Effect.bind('type1', ({ team1 }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team1.id,
                name: 'Boxing',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
          ),
        ),
        Effect.bind('type2', ({ team2 }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team2.id,
                name: 'Boxing',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
          ),
        ),
        Effect.tap(({ type1, type2 }) =>
          Effect.sync(() => {
            expect(type1.name).toBe('Boxing');
            expect(type2.name).toBe('Boxing');
            expect(type1.id).not.toBe(type2.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('updateCustom', () => {
    it.effect('updates a team-scoped custom type', () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000009', 'at-user-9')),
        Effect.bind('team', ({ userId }) =>
          createTeam('509090909090909090' as Discord.Snowflake, userId),
        ),
        Effect.bind('created', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team.id,
                name: 'OriginalName',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
          ),
        ),
        Effect.bind('updated', ({ created, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.updateCustom({
                id: created.id,
                team_id: team.id,
                name: 'UpdatedName',
                emoji: Option.some('🏊' as ActivityType.ActivityTypeEmoji),
                description: Option.some('Water sport' as ActivityType.ActivityTypeDescription),
              }),
            ),
          ),
        ),
        Effect.tap(({ updated }) =>
          Effect.sync(() => {
            const row = updated as Option.Option<ActivityTypeRow>;
            expect(Option.isSome(row)).toBe(true);
            if (Option.isSome(row)) {
              expect(row.value.name).toBe('UpdatedName');
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('is a no-op for global rows (returns none / 0 affected)', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        Effect.bind('userId', () => createUser('500000000000000010', 'at-user-10')),
        Effect.bind('team', ({ userId }) =>
          createTeam('510101010101010101' as Discord.Snowflake, userId),
        ),
        Effect.bind('result', ({ gymId, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              // updateCustom should be scoped to team_id; global rows should not match
              repo.updateCustom({
                id: gymId,
                team_id: team.id,
                name: 'HackedGym',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
            Effect.result,
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Expect either Option.none() returned or 0 affected rows
            // The exact representation depends on implementation — just verify it didn't succeed with updated data
            if (Result.isSuccess(result)) {
              // If it returns a value, it should be none (no row updated)
              expect(Option.isNone(result.success)).toBe(true);
            } else {
              // It's also acceptable to fail (e.g. ActivityTypeNotFound)
              expect(result._tag).toBe('Failure');
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('deleteCustom', () => {
    it.effect('removes a team-scoped custom type', () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000011', 'at-user-11')),
        Effect.bind('team', ({ userId }) =>
          createTeam('511111111111111111' as Discord.Snowflake, userId),
        ),
        Effect.bind('created', ({ team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertCustom({
                team_id: team.id,
                name: 'DeleteMe',
                emoji: Option.none(),
                description: Option.none(),
              }),
            ),
          ),
        ),
        Effect.tap(({ created, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.deleteCustom(created.id, team.id)),
          ),
        ),
        Effect.bind('found', ({ created, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByIdScoped(created.id, team.id)),
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

    it.effect('does NOT delete global rows', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        Effect.bind('userId', () => createUser('500000000000000012', 'at-user-12')),
        Effect.bind('team', ({ userId }) =>
          createTeam('512121212121212121' as Discord.Snowflake, userId),
        ),
        Effect.tap(({ gymId, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              // Should silently no-op because gym is a global type
              repo.deleteCustom(gymId, team.id),
            ),
          ),
        ),
        // Verify gym still exists
        Effect.bind('gymStillExists', () => getGlobalTypeId('gym')),
        Effect.tap(({ gymStillExists, gymId }) =>
          Effect.sync(() => {
            expect(gymStillExists).toBe(gymId);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('countLogsForType', () => {
    it.effect('returns the number of activity_logs referencing that activity_type_id', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        Effect.bind('userId', () => createUser('500000000000000013', 'at-user-13')),
        Effect.bind('team', ({ userId }) =>
          createTeam('513131313131313131' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.tap(({ tm, gymId }) =>
          ActivityLogsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all([
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: gymId,
                  logged_at: new Date('2026-01-01T10:00:00Z'),
                  duration_minutes: Option.none(),
                  note: Option.none(),
                  source: 'manual',
                }),
                repo.insert({
                  team_member_id: tm.id,
                  activity_type_id: gymId,
                  logged_at: new Date('2026-01-02T10:00:00Z'),
                  duration_minutes: Option.none(),
                  note: Option.none(),
                  source: 'manual',
                }),
              ]),
            ),
          ),
        ),
        Effect.bind('count', ({ gymId, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.countLogsForType(gymId, team.id)),
          ),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('returns 0 for a type with no logs', () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('gymId', () => getGlobalTypeId('gym')),
        Effect.bind('userId', () => createUser('500000000000000099', 'at-user-99')),
        Effect.bind('team', ({ userId }) =>
          createTeam('519999999999999999' as Discord.Snowflake, userId),
        ),
        Effect.bind('count', ({ gymId, team }) =>
          ActivityTypesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.countLogsForType(gymId, team.id)),
          ),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });
});
