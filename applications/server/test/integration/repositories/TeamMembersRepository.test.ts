// TDD mode — tests written BEFORE the "Handle removing user" fix is implemented.
// These tests WILL FAIL until the developer implements:
//   1. `findMembershipByIds(teamId, userId, options?: { includeInactive?: boolean })`
//      — adds AND tm.active = true by default; bypasses that filter when includeInactive === true
//   2. `findByUserQuery` — adds AND tm.active = true
//
// When all tests are green, the production code is complete.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
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
      yield* deactivateMember(team.id, (member as any).id);
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
        yield* deactivateMember(team.id, (member as any).id);
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
        yield* deactivateMember(team.id, (member as any).id);
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
      yield* deactivateMember(team2.id, (member2 as any).id);
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
      yield* deactivateMember(team.id, (member as any).id);
      const results = yield* TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findByUser(userId)),
      );
      expect(results).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
