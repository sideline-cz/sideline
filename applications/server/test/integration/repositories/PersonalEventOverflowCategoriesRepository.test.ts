// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - Migration 1790100007: CREATE TABLE personal_event_overflow_categories
//   - A new PersonalEventOverflowCategoriesRepository service with methods:
//       allocatePersonalOverflowCategory(teamId, sequence) → INSERT ON CONFLICT DO NOTHING RETURNING id
//       savePersonalOverflowCategoryId(teamId, sequence, discordCategoryId)
//       listPersonalOverflowCategories(teamId) → ordered by sequence ASC
// These tests WILL FAIL until the developer implements the repository and migration.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
// TDD: implement PersonalEventOverflowCategoriesRepository
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  // TDD: implement PersonalEventOverflowCategoriesRepository.Default
  PersonalEventOverflowCategoriesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
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

const seedTeam = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.map(({ team }) => team),
  );

// ---------------------------------------------------------------------------
// Tests: allocate sequence via ON CONFLICT DO NOTHING (race-safety)
// ---------------------------------------------------------------------------

describe('PersonalEventOverflowCategoriesRepository — allocatePersonalOverflowCategory', () => {
  it.effect('allocate with sequence=2 inserts a new row and returns its id', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam(
          '430000000000000001',
          'overflow-alloc-1',
          '431010101010101010' as Discord.Snowflake,
        ),
      ),
      Effect.bind('result', ({ team }) =>
        PersonalEventOverflowCategoriesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement allocatePersonalOverflowCategory(teamId, sequence) → Option<rowId>
            repo.allocatePersonalOverflowCategory(team.id, 2),
          ),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          // Must return Some (the RETURNING id from the INSERT)
          expect(Option.isSome(result)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'allocate with same sequence twice returns None on second call (ON CONFLICT DO NOTHING)',
    () =>
      Effect.Do.pipe(
        Effect.bind('team', () =>
          seedTeam(
            '432000000000000001',
            'overflow-alloc-2',
            '432020202020202020' as Discord.Snowflake,
          ),
        ),
        // First allocation at sequence=2
        Effect.bind('first', ({ team }) =>
          PersonalEventOverflowCategoriesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.allocatePersonalOverflowCategory(team.id, 2)),
          ),
        ),
        // Second allocation at same sequence — must be a no-op
        Effect.bind('second', ({ team }) =>
          PersonalEventOverflowCategoriesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.allocatePersonalOverflowCategory(team.id, 2)),
          ),
        ),
        Effect.tap(({ first, second }) =>
          Effect.sync(() => {
            // First allocation wins (returns Some)
            expect(Option.isSome(first)).toBe(true);
            // Second allocation is a no-op (returns None)
            expect(Option.isNone(second)).toBe(true);
          }),
        ),
        // Verify exactly one row exists
        Effect.bind('count', ({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM personal_event_overflow_categories
              WHERE team_id = '${team.id}' AND sequence = 2
            `),
            ),
            Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
          ),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'two concurrent allocations for the same (team_id, sequence) yield exactly one row total (race-safety via ON CONFLICT DO NOTHING)',
    () =>
      Effect.Do.pipe(
        Effect.bind('team', () =>
          seedTeam(
            '433000000000000001',
            'overflow-race-1',
            '433030303030303030' as Discord.Snowflake,
          ),
        ),
        // Simulate concurrent allocation by running both in parallel
        Effect.bind('results', ({ team }) =>
          PersonalEventOverflowCategoriesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all(
                [
                  repo.allocatePersonalOverflowCategory(team.id, 3),
                  repo.allocatePersonalOverflowCategory(team.id, 3),
                ],
                { concurrency: 2 },
              ),
            ),
          ),
        ),
        // Exactly one should be Some and one None
        Effect.bind('count', ({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM personal_event_overflow_categories
              WHERE team_id = '${team.id}' AND sequence = 3
            `),
            ),
            Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
          ),
        ),
        Effect.tap(({ results, count }) =>
          Effect.sync(() => {
            // One winner (Some), one loser (None)
            const somes = results.filter(Option.isSome).length;
            expect(somes).toBe(1);
            // Exactly one row in the DB
            expect(count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Tests: listPersonalOverflowCategories ordered by sequence ASC
// ---------------------------------------------------------------------------

describe('PersonalEventOverflowCategoriesRepository — listPersonalOverflowCategories', () => {
  it.effect('lists categories ordered by sequence ASC', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam(
          '434000000000000001',
          'overflow-list-1',
          '434040404040404040' as Discord.Snowflake,
        ),
      ),
      // Seed rows with sequences 3, 1, 2 (inserted out of order)
      Effect.tap(({ team }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`
            INSERT INTO personal_event_overflow_categories (team_id, discord_category_id, sequence)
            VALUES
              ('${team.id}', '434111111111111113', 3),
              ('${team.id}', '434111111111111111', 1),
              ('${team.id}', '434111111111111112', 2)
          `),
          ),
        ),
      ),
      Effect.bind('rows', ({ team }) =>
        PersonalEventOverflowCategoriesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement listPersonalOverflowCategories(teamId) → array ordered by sequence
            repo.listPersonalOverflowCategories(team.id),
          ),
        ),
      ),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows.length).toBe(3);
          // Must be ordered by sequence ascending
          const sequences = rows.map((r: any) => r.sequence);
          expect(sequences).toEqual([1, 2, 3]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('UNIQUE on discord_category_id prevents duplicates', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam(
          '435000000000000001',
          'overflow-unique-1',
          '435050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ team }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`
            INSERT INTO personal_event_overflow_categories (team_id, discord_category_id, sequence)
            VALUES ('${team.id}', '435111111111111111', 1)
          `),
          ),
        ),
      ),
      // Try inserting same discord_category_id for a different sequence — must fail
      Effect.bind('result', ({ team }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql
              .unsafe(`
            INSERT INTO personal_event_overflow_categories (team_id, discord_category_id, sequence)
            VALUES ('${team.id}', '435111111111111111', 2)
          `)
              .pipe(Effect.exit),
          ),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(Exit.isFailure(result)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
