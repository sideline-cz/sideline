// NOTE: These tests are written in TDD mode BEFORE the implementation exists.
// They target ActivityLogsRepository.insertAutoIgnoreConflict which does not
// yet exist. All tests for insertAutoIgnoreConflict SHOULD FAIL until the
// developer implements the method.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
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
        name: 'AL Test Team',
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

/**
 * Seed global activity types (team_id = NULL).
 * Same helper pattern as ActivityTypesRepository.test.ts.
 */
const seedGlobalTypes = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`
          INSERT INTO activity_types (team_id, name, slug)
          VALUES
            (NULL, 'Training', 'training')
          ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING
        `,
    ),
    Effect.asVoid,
  );

const getTrainingTypeId = () =>
  ActivityTypesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findBySlug('training')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error("Global type 'training' not found")),
        onSome: Effect.succeed,
      }),
    ),
    Effect.map((t) => t.id),
  );

/** Count auto-source rows for a given member + type + UTC date. */
const countAutoRows = (teamMemberId: string, activityTypeId: string, utcDate: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql<{ count: string }>`
        SELECT count(*) AS count
        FROM activity_logs
        WHERE team_member_id = ${teamMemberId}
          AND activity_type_id = ${activityTypeId}
          AND source = 'auto'
          AND (logged_at AT TIME ZONE 'UTC')::date = ${utcDate}::date
      `.pipe(Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10))),
    ),
  );

// ---------------------------------------------------------------------------
// Tests — insertAutoIgnoreConflict
// ---------------------------------------------------------------------------

describe('ActivityLogsRepository.insertAutoIgnoreConflict', () => {
  it.effect('first call → one auto row created', () =>
    Effect.Do.pipe(
      Effect.tap(() => seedGlobalTypes()),
      Effect.bind('userId', () => createUser('400000000000000001', 'al-auto-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('400000000400000001' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('typeId', () => getTrainingTypeId()),
      Effect.bind('repo', () => ActivityLogsRepository.asEffect()),
      Effect.tap(({ repo, member }) =>
        repo.insertAutoIgnoreConflict({
          team_member_id: member.id,
          logged_at: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
      Effect.bind('count', ({ member, typeId }) => countAutoRows(member.id, typeId, '2026-06-15')),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'second call same member/type/same UTC day → no new row (count stays 1), no error',
    () =>
      Effect.Do.pipe(
        Effect.tap(() => seedGlobalTypes()),
        Effect.bind('userId', () => createUser('400000000000000011', 'al-auto-2')),
        Effect.bind('team', ({ userId }) =>
          createTeam('400000000400000002' as Discord.Snowflake, userId),
        ),
        Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.bind('typeId', () => getTrainingTypeId()),
        Effect.bind('repo', () => ActivityLogsRepository.asEffect()),
        // First insert
        Effect.tap(({ repo, member }) =>
          repo.insertAutoIgnoreConflict({
            team_member_id: member.id,
            logged_at: new Date('2026-06-15T10:00:00Z'),
          }),
        ),
        // Second insert — same member, same type, same UTC day (different time)
        Effect.tap(({ repo, member }) =>
          repo.insertAutoIgnoreConflict({
            team_member_id: member.id,
            logged_at: new Date('2026-06-15T18:30:00Z'),
          }),
        ),
        Effect.bind('count', ({ member, typeId }) =>
          countAutoRows(member.id, typeId, '2026-06-15'),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            // Dedup: still only one row
            expect(count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('different day → new row (count becomes 2)', () =>
    Effect.Do.pipe(
      Effect.tap(() => seedGlobalTypes()),
      Effect.bind('userId', () => createUser('400000000000000021', 'al-auto-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('400000000400000003' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('typeId', () => getTrainingTypeId()),
      Effect.bind('repo', () => ActivityLogsRepository.asEffect()),
      // Day 1
      Effect.tap(({ repo, member }) =>
        repo.insertAutoIgnoreConflict({
          team_member_id: member.id,
          logged_at: new Date('2026-06-14T10:00:00Z'),
        }),
      ),
      // Day 2
      Effect.tap(({ repo, member }) =>
        repo.insertAutoIgnoreConflict({
          team_member_id: member.id,
          logged_at: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
      // Count rows from both days
      Effect.bind('countDay1', ({ member, typeId }) =>
        countAutoRows(member.id, typeId, '2026-06-14'),
      ),
      Effect.bind('countDay2', ({ member, typeId }) =>
        countAutoRows(member.id, typeId, '2026-06-15'),
      ),
      Effect.tap(({ countDay1, countDay2 }) =>
        Effect.sync(() => {
          expect(countDay1).toBe(1);
          expect(countDay2).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('real SqlError propagates (e.g. nonexistent member FK) → failure, not swallowed', () =>
    Effect.Do.pipe(
      Effect.tap(() => seedGlobalTypes()),
      Effect.bind('repo', () => ActivityLogsRepository.asEffect()),
      Effect.bind('exit', ({ repo }) =>
        repo
          .insertAutoIgnoreConflict({
            // Nonexistent team_member_id → FK constraint violation
            team_member_id: '00000000-0000-4000-ffff-000000000001' as TeamMember.TeamMemberId,
            logged_at: new Date('2026-06-15T10:00:00Z'),
          })
          .pipe(Effect.exit),
      ),
      Effect.tap(({ exit }) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
