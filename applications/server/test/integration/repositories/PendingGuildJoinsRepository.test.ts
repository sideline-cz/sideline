// ---------------------------------------------------------------------------
// TDD for PR-4 (Discord onboarding fix), CC-13 — `enqueue`'s idempotency.
//
// `PendingGuildJoinsRepository._enqueue`'s upsert (`PendingGuildJoinsRepository.ts:18-26`)
// currently has NO status predicate on its `ON CONFLICT ... DO UPDATE`, so it resets a `done`
// row back to `pending` — silently re-adding a user to a guild they deliberately left (S4 is
// violated: `enqueue` must only ever fire from an explicit user click, and a `done` row means
// the auto-join already succeeded and nothing about "leaving" is tracked here, so treating
// `done` as terminal is the only safe default).
//
// PR-4 step 2 fixes this by adding `WHERE pending_guild_joins.status <> 'done'` to the
// `DO UPDATE`. Test 1 below (`.work-plans/discord-onboarding-fix-plan.md` PR-4 test list item
// 14) MUST FAIL against current code. Test 2 (item 15) is a stable regression guard — `failed`
// rows must still revive via `enqueue`, which already works today and must keep working.
// ---------------------------------------------------------------------------

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PendingGuildJoinsRepository.Default,
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

const insertRow = (
  userId: User.UserId,
  teamId: Team.TeamId,
  status: 'pending' | 'done' | 'failed',
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO pending_guild_joins (user_id, team_id, status, processed_at)
        VALUES (
          ${userId},
          ${teamId},
          ${status},
          ${status === 'pending' ? null : new Date()}
        )
      `,
    ),
  );

const statusOf = (userId: User.UserId, teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ status: string }>`
        SELECT status FROM pending_guild_joins WHERE user_id = ${userId} AND team_id = ${teamId}
      `,
    ),
    Effect.map((rows) => rows[0]?.status),
  );

const insertMembership = (userId: User.UserId, teamId: Team.TeamId, active: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO team_members (team_id, user_id, active)
        VALUES (${teamId}, ${userId}, ${active})
      `,
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PendingGuildJoinsRepository — enqueue idempotency (CC-13)', () => {
  // REGRESSION TEST — this is the bug. MUST FAIL against current code: today's
  // `ON CONFLICT DO UPDATE` has no status predicate, so it resets `done` back to `pending`.
  it.effect("does not reset a 'done' row back to 'pending'", () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('810000000000000001', 'pgj-done-user')),
      Effect.bind('team', ({ user }) =>
        createTeam('910000000000000001' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ user, team }) => insertRow(user.id, team.id, 'done')),
      Effect.bind('repo', () => PendingGuildJoinsRepository.asEffect()),
      Effect.tap(({ repo, user, team }) => repo.enqueue(user.id, team.id)),
      Effect.bind('status', ({ user, team }) => statusOf(user.id, team.id)),
      Effect.tap(({ status }) =>
        Effect.sync(() => {
          expect(status).toBe('done');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Stable regression guard — `failed` rows are recoverable by design (CC-13's whole point is
  // that `'failed'`, unlike `'done'`, is exactly what `requeueFailedForUser` AND `enqueue`
  // revive). This already passes today and must keep passing after PR-4's WHERE clause lands.
  it.effect("does requeue a 'failed' row back to 'pending'", () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('810000000000000002', 'pgj-failed-user')),
      Effect.bind('team', ({ user }) =>
        createTeam('910000000000000002' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ user, team }) => insertRow(user.id, team.id, 'failed')),
      Effect.bind('repo', () => PendingGuildJoinsRepository.asEffect()),
      Effect.tap(({ repo, user, team }) => repo.enqueue(user.id, team.id)),
      Effect.bind('status', ({ user, team }) => statusOf(user.id, team.id)),
      Effect.tap(({ status }) =>
        Effect.sync(() => {
          expect(status).toBe('pending');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// TDD for BLOCKER 2 (review of PR-4) — `requeueFailedForUser` must only revive rows whose team
// membership is still active.
//
// Sequence this closes: join → enqueue → bot's addGuildMember 401s (expired token) → row
// `'failed'` → user joins manually via the discord.gg link (nothing ever marks the row `'done'`)
// → user leaves the guild deliberately → `Guild/RemoveMember` deactivates the team membership
// but never touches `pending_guild_joins` → user logs in → `requeueFailedForUser` fires on
// every login → row flips back to `'pending'` → the bot re-adds them. Forever.
//
// Test 1 below MUST FAIL against current code (no membership predicate — a `'failed'` row is
// requeued regardless of whether the membership is still active). Test 2 is a regression guard:
// an active membership must still be revivable, exactly as it is today.
// ---------------------------------------------------------------------------
describe('PendingGuildJoinsRepository — requeueFailedForUser respects membership intent (BLOCKER 2)', () => {
  it.effect("does NOT requeue a 'failed' row whose team membership is inactive", () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('810000000000000003', 'pgj-left-guild-user')),
      Effect.bind('team', ({ user }) =>
        createTeam('910000000000000003' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ user, team }) => insertRow(user.id, team.id, 'failed')),
      Effect.tap(({ user, team }) => insertMembership(user.id, team.id, false)),
      Effect.bind('repo', () => PendingGuildJoinsRepository.asEffect()),
      Effect.tap(({ repo, user }) => repo.requeueFailedForUser(user.id)),
      Effect.bind('status', ({ user, team }) => statusOf(user.id, team.id)),
      Effect.tap(({ status }) =>
        Effect.sync(() => {
          expect(status).toBe('failed');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("does requeue a 'failed' row whose team membership is still active", () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('810000000000000004', 'pgj-still-in-guild-user')),
      Effect.bind('team', ({ user }) =>
        createTeam('910000000000000004' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ user, team }) => insertRow(user.id, team.id, 'failed')),
      Effect.tap(({ user, team }) => insertMembership(user.id, team.id, true)),
      Effect.bind('repo', () => PendingGuildJoinsRepository.asEffect()),
      Effect.tap(({ repo, user }) => repo.requeueFailedForUser(user.id)),
      Effect.bind('status', ({ user, team }) => statusOf(user.id, team.id)),
      Effect.tap(({ status }) =>
        Effect.sync(() => {
          expect(status).toBe('pending');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
