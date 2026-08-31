// TDD mode — tests written BEFORE the "Handle removing user" fix is implemented.
// These tests WILL FAIL until the developer implements:
//   1. `findMembershipByIds(teamId, userId, options?: { includeInactive?: boolean })`
//      — adds AND tm.active = true by default; bypasses that filter when includeInactive === true
//   2. `findByUserQuery` — adds AND tm.active = true
//
// When all tests are green, the production code is complete.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  BotGuildsRepository.Default,
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
        name: 'Members Test Team',
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
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

const deactivateMember = (teamId: Team.TeamId, memberId: string) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.deactivateMemberByIds(
        teamId,
        memberId as import('@sideline/domain').TeamMember.TeamMemberId,
      ),
    ),
  );

// ---------------------------------------------------------------------------
// findMembershipByIds — default behaviour (active-only)
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — findMembershipByIds', () => {
  it.effect('returns Some for an active membership row', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000001', 'mbr-active-1');
      const team = yield* createTeam('800100000000000000' as Discord.Snowflake, userId);
      yield* addActiveMember(team.id, userId);
      const result = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findMembershipByIds(team.id, userId)),
      );
      expect(Option.isSome(result)).toBe(true);
      const m = Option.getOrThrow(result);
      expect(m.active).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns None for an inactive membership row (default active-only filter)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000002', 'mbr-inactive-1');
      const team = yield* createTeam('800200000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      // Deactivate the membership
      yield* deactivateMember(team.id, member.id);
      const result = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findMembershipByIds(team.id, userId)),
      );
      // Default behaviour: inactive membership MUST be invisible
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'with { includeInactive: true } returns Some with active===false for deactivated member',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('800000000000000003', 'mbr-inactive-2');
        const team = yield* createTeam('800300000000000000' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        // Deactivate the membership
        yield* deactivateMember(team.id, member.id);
        const result = yield* TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findMembershipByIds(team.id, userId, { includeInactive: true }),
          ),
        );
        // With includeInactive: true, the row must be visible
        expect(Option.isSome(result)).toBe(true);
        const m = Option.getOrThrow(result);
        expect(m.active).toBe(false);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'with { includeInactive: false } returns None for inactive — identical to default',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('800000000000000004', 'mbr-inactive-3');
        const team = yield* createTeam('800400000000000000' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        yield* deactivateMember(team.id, member.id);
        const result = yield* TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findMembershipByIds(team.id, userId, { includeInactive: false }),
          ),
        );
        expect(Option.isNone(result)).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// findByUser — active-only filter
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — findByUser', () => {
  it.effect('returns only active memberships across multiple teams', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000010', 'mbr-multi-user');
      const team1 = yield* createTeam('800500000000000000' as Discord.Snowflake, userId);
      const team2 = yield* createTeam('800500000000000001' as Discord.Snowflake, userId);
      yield* addActiveMember(team1.id, userId);
      const member2 = yield* addActiveMember(team2.id, userId);
      // Deactivate membership in team2
      yield* deactivateMember(team2.id, member2.id);
      const results = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findByUser(userId)),
      );
      // Only the active team should appear
      expect(results).toHaveLength(1);
      expect(results[0]?.team_id).toBe(team1.id);
      // team2 membership is inactive — must NOT be present
      const hasTeam2 = results.some((m) => m.team_id === team2.id);
      expect(hasTeam2).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns [] when user has only deactivated memberships', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000011', 'mbr-all-inactive');
      const team = yield* createTeam('800600000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      yield* deactivateMember(team.id, member.id);
      const results = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findByUser(userId)),
      );
      expect(results).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // PR-9 / CC-15 — `findByUser` is what `auth.myTeams` derives `discordJoined` from. Real DB
  // coverage of the two columns the tri-state gate reads, including the anti-lockout case: a
  // team whose guild has no `bot_guilds` row at all (backfill never ran) must decode
  // `members_backfilled_at` as `None`, not silently vanish or produce a false "confirmed absent".
  it.effect('carries discord_joined_at and members_backfilled_at through the guild LEFT JOIN', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000012', 'mbr-discord-state');
      const botGuilds = yield* BotGuildsRepository.asEffect();
      const members = yield* TeamMembersRepository.asEffect();

      const backfilledGuildId = '800700000000000001' as Discord.Snowflake;
      yield* botGuilds.upsert(backfilledGuildId, 'Backfilled Guild', false);
      yield* botGuilds.markMembersBackfilled(backfilledGuildId);
      const backfilledTeam = yield* createTeam(backfilledGuildId, userId);
      const joinedMember = yield* addActiveMember(backfilledTeam.id, userId);
      yield* members.markDiscordJoined(joinedMember.id);

      const unbackfilledGuildId = '800700000000000002' as Discord.Snowflake;
      // No bot_guilds row at all for this guild — the backfill never ran.
      const unbackfilledTeam = yield* createTeam(unbackfilledGuildId, userId);
      yield* addActiveMember(unbackfilledTeam.id, userId);

      const results = yield* members.findByUser(userId);

      const joinedRow = results.find((r) => r.team_id === backfilledTeam.id);
      expect(joinedRow).toBeDefined();
      expect(Option.isSome(joinedRow?.discord_joined_at ?? Option.none())).toBe(true);
      expect(Option.isSome(joinedRow?.members_backfilled_at ?? Option.none())).toBe(true);

      const unbackfilledRow = results.find((r) => r.team_id === unbackfilledTeam.id);
      expect(unbackfilledRow).toBeDefined();
      expect(
        Option.isNone(unbackfilledRow?.discord_joined_at ?? Option.some(DateTime.nowUnsafe())),
      ).toBe(true);
      expect(
        Option.isNone(unbackfilledRow?.members_backfilled_at ?? Option.some(DateTime.nowUnsafe())),
      ).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// PR-9 / CC-15 — `findDiscordJoinedAt` is what `getJoinStatus` / `getMyPendingDiscordJoin` /
// `regenerateMyDiscordInvite` derive `JoinStatus.state = 'joined'` from.
describe('TeamMembersRepository — findDiscordJoinedAt', () => {
  it.effect(
    'returns None before markDiscordJoined, Some after, None again after clearDiscordJoined',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('800000000000000013', 'mbr-find-joined');
        const team = yield* createTeam('800700000000000003' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        const members = yield* TeamMembersRepository.asEffect();

        const before = yield* members.findDiscordJoinedAt(team.id, userId);
        expect(Option.isNone(before)).toBe(true);

        yield* members.markDiscordJoined(member.id);
        const after = yield* members.findDiscordJoinedAt(team.id, userId);
        expect(Option.isSome(after)).toBe(true);

        yield* members.clearDiscordJoined(member.id);
        const afterClear = yield* members.findDiscordJoinedAt(team.id, userId);
        expect(Option.isNone(afterClear)).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// PR-9c — `findLastRoleSync` reads `team_members.last_role_sync_*`
// (`RoleSyncEventsRepository.recordLastRoleSync` is the only writer). Exercised against REAL,
// non-null TIMESTAMPTZ rows on purpose: a `Schema.DateTimeUtc` vs `Schema.DateTimeUtcFromDate`
// mixup on this column type-checks and passes against every mocked test (`Schema.OptionFromNullOr`
// short-circuits on NULL, so the inner decoder is never reached), and only throws once a real
// non-null timestamp comes back from node-pg as a JS `Date`.
describe('TeamMembersRepository — findLastRoleSync', () => {
  const setLastRoleSync = (memberId: string, state: 'ok' | 'failed', errorCode: string | null) =>
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) => sql`
          UPDATE team_members
          SET last_role_sync_at = now(), last_role_sync_state = ${state}, last_role_sync_error = ${errorCode}
          WHERE id = ${memberId}
        `,
      ),
    );

  it.effect('returns None for a member that has never completed a role sync', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000040', 'lastsync-none');
      const team = yield* createTeam('800700000000000040' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      const members = yield* TeamMembersRepository.asEffect();

      const result = yield* members.findLastRoleSync(member.id);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns Some with a real DateTime.Utc and no error code for state=ok', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000041', 'lastsync-ok');
      const team = yield* createTeam('800700000000000041' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      yield* setLastRoleSync(member.id, 'ok', null);

      const members = yield* TeamMembersRepository.asEffect();
      const result = yield* members.findLastRoleSync(member.id);

      expect(Option.isSome(result)).toBe(true);
      const value = Option.getOrThrow(result);
      expect(value.state).toBe('ok');
      expect(Option.isNone(value.errorCode)).toBe(true);
      // The regression this guards: `at` MUST decode into a real DateTime.Utc from the non-null
      // column, not silently pass through as an undecoded/NULL value.
      expect(DateTime.isDateTime(value.at)).toBe(true);
      expect(Math.abs(DateTime.toEpochMillis(value.at) - Date.now())).toBeLessThan(60_000);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns Some with the recorded error code for state=failed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000042', 'lastsync-failed');
      const team = yield* createTeam('800700000000000042' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      yield* setLastRoleSync(member.id, 'failed', 'captain_action');

      const members = yield* TeamMembersRepository.asEffect();
      const result = yield* members.findLastRoleSync(member.id);

      expect(Option.isSome(result)).toBe(true);
      const value = Option.getOrThrow(result);
      expect(value.state).toBe('failed');
      expect(Option.getOrNull(value.errorCode)).toBe('captain_action');
      expect(DateTime.isDateTime(value.at)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// findRosterMemberByIds — includeInactive option
//
// Regression coverage for the member-detail-page follow-up: getMember/
// reactivateMember/listMemberRosters/listMemberGroups all need to look up a
// DEACTIVATED member by id without the default active-only filter hiding it.
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — findRosterMemberByIds', () => {
  it.effect('without includeInactive returns None for a deactivated member', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000020', 'roster-inactive-1');
      const team = yield* createTeam('800700000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      yield* deactivateMember(team.id, member.id);
      const result = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, member.id)),
      );
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'with { includeInactive: true } returns Some with active===false for a deactivated member',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('800000000000000021', 'roster-inactive-2');
        const team = yield* createTeam('800800000000000000' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        yield* deactivateMember(team.id, member.id);
        const result = yield* TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findRosterMemberByIds(team.id, member.id, { includeInactive: true }),
          ),
        );
        expect(Option.isSome(result)).toBe(true);
        const entry = Option.getOrThrow(result);
        expect(entry.active).toBe(false);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns Some with active===true for an active member (default)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000022', 'roster-active-1');
      const team = yield* createTeam('800900000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      const result = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, member.id)),
      );
      expect(Option.isSome(result)).toBe(true);
      const entry = Option.getOrThrow(result);
      expect(entry.active).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// reactivateMember — flips active back to true
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — reactivateMember', () => {
  it.effect('flips a deactivated member back to active', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('800000000000000030', 'reactivate-1');
      const team = yield* createTeam('801000000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      yield* deactivateMember(team.id, member.id);

      const deactivated = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.findRosterMemberByIds(team.id, member.id, { includeInactive: true }),
        ),
      );
      expect(Option.getOrThrow(deactivated).active).toBe(false);

      yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.reactivateMember(member.id)),
      );

      const reactivated = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, member.id)),
      );
      expect(Option.isSome(reactivated)).toBe(true);
      expect(Option.getOrThrow(reactivated).active).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});
