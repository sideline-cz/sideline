// TDD mode — tests written BEFORE the FeesRepository implementation exists.
// These tests WILL FAIL until the developer implements FeesRepository.
//
// Required implementation:
//   - applications/server/src/repositories/FeesRepository.ts

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FeesRepository.Default,
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
        name: 'Finance Test Team',
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

const insertFee = (teamId: Team.TeamId) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Annual Fee',
        description: Option.none(),
        amount_minor: 5000,
        currency: 'CZK',
        due_at: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeesRepository — insert', () => {
  it.effect('insert returns a row with an id and correct defaults', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000001', 'fees-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900100000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      Effect.tap(({ fee }) =>
        Effect.sync(() => {
          expect(fee.id).toBeTruthy();
          expect(fee.name).toBe('Annual Fee');
          expect(fee.amount_minor).toBe(5000);
          expect(fee.currency).toBe('CZK');
          expect(fee.recurrence).toBe('none');
          expect(fee.target_scope).toBe('all_members');
          expect(Option.isNone(fee.archived_at)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeesRepository — findById', () => {
  it.effect('findById returns the inserted fee', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000002', 'fees-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900200000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      Effect.bind('found', ({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(fee.id))),
      ),
      Effect.tap(({ found, fee }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(row.id).toBe(fee.id);
          expect(row.name).toBe('Annual Fee');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findById returns None for an archived fee', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000003', 'fees-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900300000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      Effect.tap(({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(fee.id))),
      ),
      Effect.bind('found', ({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(fee.id))),
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

describe('FeesRepository — listByTeam', () => {
  it.effect('listByTeam returns fees for a team, filters out archived', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000004', 'fees-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900400000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee1', ({ team }) => insertFee(team.id)),
      Effect.bind('fee2', ({ team }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              name: 'Training Fee',
              description: Option.none(),
              amount_minor: 2000,
              currency: 'CZK',
              due_at: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ fee2 }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(fee2.id))),
      ),
      Effect.bind('list', ({ team }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.listByTeam(team.id))),
      ),
      Effect.tap(({ list, fee1, fee2 }) =>
        Effect.sync(() => {
          const ids = list.map((f) => f.id);
          expect(ids).toContain(fee1.id);
          expect(ids).not.toContain(fee2.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeesRepository — update', () => {
  it.effect('update updates only provided fields (PATCH semantics)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000005', 'fees-owner-5')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900500000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      Effect.bind('updated', ({ fee }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(fee.id, {
              name: Option.some('Updated Fee Name'),
              description: Option.none(),
              amount_minor: Option.none(),
              currency: Option.none(),
              due_at: Option.none(),
              target_scope: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ updated, fee }) =>
        Effect.sync(() => {
          expect(updated.id).toBe(fee.id);
          expect(updated.name).toBe('Updated Fee Name');
          // Unchanged fields remain the same
          expect(updated.amount_minor).toBe(5000);
          expect(updated.currency).toBe('CZK');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeesRepository — archive', () => {
  it.effect('archive sets archived_at and is idempotent (second call is no-op)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000006', 'fees-owner-6')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900600000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      // First archive call
      Effect.tap(({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(fee.id))),
      ),
      // Second archive call (idempotent — must not error)
      Effect.tap(({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(fee.id))),
      ),
      Effect.bind('found', ({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(fee.id))),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          // Still not visible via findById (which filters archived)
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeesRepository — delete cascades to assignments', () => {
  it.effect('deleting a fee cascades and removes associated assignments', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000007', 'fees-owner-7')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900700000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: ownerId,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      // Insert an assignment for the fee
      Effect.tap(({ fee, member }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAssignmentForTest(fee.id, (member as any).id, 5000)),
        ),
      ),
      // Delete the fee
      Effect.tap(({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.delete_(fee.id))),
      ),
      // Verify assignment count is zero
      Effect.bind('assignmentCount', ({ fee }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.countAssignmentsByFeeId(fee.id)),
        ),
      ),
      Effect.tap(({ assignmentCount }) =>
        Effect.sync(() => {
          expect(assignmentCount).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeesRepository — findWithCountsById count correctness (regression: no N² inflation)', () => {
  it.effect('findWithCountsById on a fee with 3 assignments → assignment_count = 3, not 9', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('900000000000000008', 'fees-owner-8')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('900800000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => insertFee(team.id)),
      // Add three distinct members to the team
      Effect.bind('member1', ({ team, ownerId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: ownerId,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      Effect.bind('user2', () => createUser('900000000000000081', 'fees-owner-8-user2')),
      Effect.bind('member2', ({ team, user2 }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: user2,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      Effect.bind('user3', () => createUser('900000000000000082', 'fees-owner-8-user3')),
      Effect.bind('member3', ({ team, user3 }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: user3,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      // Insert three assignments
      Effect.tap(({ fee, member1 }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAssignmentForTest(fee.id, (member1 as any).id, 5000)),
        ),
      ),
      Effect.tap(({ fee, member2 }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAssignmentForTest(fee.id, (member2 as any).id, 5000)),
        ),
      ),
      Effect.tap(({ fee, member3 }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAssignmentForTest(fee.id, (member3 as any).id, 5000)),
        ),
      ),
      Effect.bind('found', ({ fee }) =>
        FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findWithCountsById(fee.id))),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          // With N² bug: 3 assignments × 3 view rows = 9. Correct answer: 3.
          expect(row.assignment_count).toBe(3);
          expect(row.paid_count).toBe(0);
          expect(row.pending_count).toBe(3);
          expect(row.overdue_count).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
