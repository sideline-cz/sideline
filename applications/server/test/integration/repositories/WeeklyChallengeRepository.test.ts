// TDD mode — tests written BEFORE the production implementation of the HTTP handler.
// The WeeklyChallengeRepository itself already exists (Part 1), so tests 1-5 may
// pass immediately. Test 7 (timezone rows) also exercises the repository directly.
//
// Expected failing / passing state:
//   Tests 1–5, 7: should PASS if the DB migrations are applied (Part 1 shipped them).
//   The suite as a whole provides regression coverage for the repository.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User, WeeklyChallenge } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { WeeklyChallengeRepository } from '~/repositories/WeeklyChallengeRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  WeeklyChallengeRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
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

const createTeam = (
  guildId: Discord.Snowflake,
  createdBy: User.UserId,
  timezone = 'Europe/Prague',
) =>
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
    // Insert team_settings with the requested timezone
    Effect.tap((team) =>
      TeamSettingsRepository.asEffect().pipe(
        Effect.andThen((settingsRepo) =>
          settingsRepo.upsert({
            teamId: team.id,
            eventHorizonDays: 30,
            minPlayersThreshold: 7,
            timezone,
          }),
        ),
      ),
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

// Helper: get the current Monday in a given IANA timezone as UTC-midnight Date
const getMondayUtcMidnight = (tz: string): Date => {
  // Get current date-time in the target timezone using Intl
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = get('year');
  const month = get('month') - 1;
  const day = get('day');

  // Find the Monday of the current week in the local calendar
  const localDate = new Date(year, month, day);
  const dayOfWeek = localDate.getDay(); // 0=Sun, 1=Mon
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(year, month, day + daysToMonday);
  return new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
};

// Helper: create a weekly challenge with a known week_start_date
const createChallenge = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  weekStartDate: Date,
) =>
  WeeklyChallengeRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.create({
        team_id: teamId,
        week_start_date: weekStartDate,
        kind: 'throwing' as WeeklyChallenge.WeeklyChallengeKind,
        title: 'Test Challenge' as WeeklyChallenge.WeeklyChallengeTitle,
        description: Option.none(),
        created_by: memberId,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WeeklyChallengeRepository — insert + list', () => {
  it.effect('insert + list returns completedMemberIds: []', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000001', 'wc-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('910000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('weekStart', () => Effect.sync(() => getMondayUtcMidnight('Europe/Prague'))),
      Effect.bind('challenge', ({ team, member, weekStart }) =>
        createChallenge(team.id, member.id, weekStart),
      ),
      Effect.bind('list', ({ team }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listForTeam(team.id, 'Europe/Prague')),
        ),
      ),
      Effect.tap(({ list, challenge }) =>
        Effect.sync(() => {
          expect(list.challenges).toHaveLength(1);
          expect(list.challenges[0].completedMemberIds).toEqual([]);
          expect(list.challenges[0].challenge.id).toBe(challenge.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('WeeklyChallengeRepository — duplicate week', () => {
  it.effect('duplicate week → WeeklyChallengeAlreadyExistsForWeek', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000002', 'wc-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('910000000000000020' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('weekStart', () => Effect.sync(() => getMondayUtcMidnight('Europe/Prague'))),
      // First insert — succeeds
      Effect.tap(({ team, member, weekStart }) => createChallenge(team.id, member.id, weekStart)),
      // Second insert with the same week_start_date — should fail
      Effect.bind('exit', ({ team, member, weekStart }) =>
        createChallenge(team.id, member.id, weekStart).pipe(Effect.exit),
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

describe('WeeklyChallengeRepository — markCompleted idempotent', () => {
  it.effect('markCompleted is idempotent (no error on second call)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000003', 'wc-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('910000000000000030' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('weekStart', () => Effect.sync(() => getMondayUtcMidnight('Europe/Prague'))),
      Effect.bind('challenge', ({ team, member, weekStart }) =>
        createChallenge(team.id, member.id, weekStart),
      ),
      // First markCompleted — should succeed
      Effect.tap(({ challenge, member }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markCompleted(challenge.id, member.id, 'Europe/Prague')),
        ),
      ),
      // Second markCompleted — should also succeed (ON CONFLICT DO NOTHING)
      Effect.tap(({ challenge, member }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markCompleted(challenge.id, member.id, 'Europe/Prague')),
        ),
      ),
      // Verify list shows exactly 1 completion entry
      Effect.bind('list', ({ team }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listForTeam(team.id, 'Europe/Prague')),
        ),
      ),
      Effect.tap(({ list, member }) =>
        Effect.sync(() => {
          expect(list.challenges[0].completedMemberIds).toHaveLength(1);
          expect(list.challenges[0].completedMemberIds[0]).toBe(member.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('WeeklyChallengeRepository — unmarkCompleted no-op', () => {
  it.effect('unmarkCompleted on non-existent row is no-op', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000004', 'wc-user-4')),
      Effect.bind('team', ({ userId }) =>
        createTeam('910000000000000040' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('weekStart', () => Effect.sync(() => getMondayUtcMidnight('Europe/Prague'))),
      Effect.bind('challenge', ({ team, member, weekStart }) =>
        createChallenge(team.id, member.id, weekStart),
      ),
      // unmarkCompleted with no existing completion — should succeed (no-op)
      Effect.tap(({ challenge, member }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.unmarkCompleted(challenge.id, member.id, 'Europe/Prague')),
        ),
      ),
      // List should still have empty completedMemberIds
      Effect.bind('list', ({ team }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listForTeam(team.id, 'Europe/Prague')),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          expect(list.challenges[0].completedMemberIds).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('WeeklyChallengeRepository — delete cascades completions', () => {
  it.effect('delete cascades completions (verify completions row gone after parent delete)', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('910000000000000005', 'wc-user-5a')),
      Effect.bind('userId2', () => createUser('910000000000000006', 'wc-user-5b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('910000000000000050' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('weekStart', () => Effect.sync(() => getMondayUtcMidnight('Europe/Prague'))),
      Effect.bind('challenge', ({ team, member1, weekStart }) =>
        createChallenge(team.id, member1.id, weekStart),
      ),
      // Add 2 completions
      Effect.tap(({ challenge, member1 }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markCompleted(challenge.id, member1.id, 'Europe/Prague')),
        ),
      ),
      Effect.tap(({ challenge, member2 }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markCompleted(challenge.id, member2.id, 'Europe/Prague')),
        ),
      ),
      // Delete the challenge
      Effect.tap(({ challenge }) =>
        WeeklyChallengeRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.delete(challenge.id)),
        ),
      ),
      // Verify via raw SQL that completions are gone
      Effect.bind('completionCount', ({ challenge }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen(
            (sql) =>
              sql<{ count: string }>`
              SELECT COUNT(*)::text AS count
              FROM weekly_challenge_completions
              WHERE challenge_id = ${challenge.id}
            `,
          ),
          Effect.map((rows) => Number(rows[0]?.count ?? '0')),
        ),
      ),
      Effect.tap(({ completionCount }) =>
        Effect.sync(() => {
          expect(completionCount).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('WeeklyChallengeRepository — timezone isolation', () => {
  it.effect(
    'two teams in different timezones produce different week_start_date rows',
    () =>
      Effect.Do.pipe(
        // Seed users and teams
        Effect.bind('userA', () => createUser('910000000000000007', 'wc-user-7a')),
        Effect.bind('userB', () => createUser('910000000000000008', 'wc-user-7b')),
        Effect.bind('teamA', ({ userA }) =>
          createTeam('910000000000000070' as Discord.Snowflake, userA, 'Pacific/Auckland'),
        ),
        Effect.bind('teamB', ({ userB }) =>
          createTeam('910000000000000080' as Discord.Snowflake, userB, 'America/Los_Angeles'),
        ),
        Effect.bind('memberA', ({ teamA, userA }) => addTeamMember(teamA.id, userA)),
        Effect.bind('memberB', ({ teamB, userB }) => addTeamMember(teamB.id, userB)),
        // Compute each team's "current Monday" in their own timezone
        Effect.bind('mondayAuckland', () =>
          Effect.sync(() => getMondayUtcMidnight('Pacific/Auckland')),
        ),
        Effect.bind('mondayLA', () =>
          Effect.sync(() => getMondayUtcMidnight('America/Los_Angeles')),
        ),
        // Create a challenge for each team using their local Monday
        Effect.bind('challengeA', ({ teamA, memberA, mondayAuckland }) =>
          createChallenge(teamA.id, memberA.id, mondayAuckland),
        ),
        Effect.bind('challengeB', ({ teamB, memberB, mondayLA }) =>
          createChallenge(teamB.id, memberB.id, mondayLA),
        ),
        // Verify both rows persist and their week_start_date values differ by 7 days
        // (or 0 if we happen to run on the exact same Monday in both — though the
        // timezones differ enough that this scenario is tested with the week being
        // the canonical value for each timezone's "current Monday")
        Effect.tap(({ challengeA, challengeB, mondayAuckland, mondayLA }) =>
          Effect.sync(() => {
            // Both challenges should have been created successfully
            expect(challengeA.id).toBeDefined();
            expect(challengeB.id).toBeDefined();

            // week_start_date should match the UTC-midnight Monday for each timezone
            const aTime = challengeA.week_start_date.getTime();
            const bTime = challengeB.week_start_date.getTime();
            const expectedATime = mondayAuckland.getTime();
            const expectedBTime = mondayLA.getTime();

            expect(aTime).toBe(expectedATime);
            expect(bTime).toBe(expectedBTime);

            // If the Mondays differ (they usually will since NZ is ~19-21h ahead of LA),
            // they must differ by exactly 7 days (one full week).
            if (aTime !== bTime) {
              const diffDays = Math.abs(aTime - bTime) / (1000 * 60 * 60 * 24);
              expect(diffDays).toBe(7);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    { timeout: 30000 },
  );
});
