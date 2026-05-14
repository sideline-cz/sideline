// TDD mode — tests written BEFORE FeeAssignmentsRepository implementation exists.
// These tests WILL FAIL until the developer implements FeeAssignmentsRepository.
//
// Required implementation:
//   - applications/server/src/repositories/FeesRepository.ts
//   - applications/server/src/repositories/FeeAssignmentsRepository.ts

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FeeAssignmentsRepository.Default,
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
        name: 'Assignment Test Team',
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

const createFee = (teamId: Team.TeamId, amountMinor = 5000) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Test Fee',
        description: Option.none(),
        amount_minor: amountMinor,
        currency: 'CZK',
        due_at: Option.none(),
      }),
    ),
  );

const addMember = (teamId: Team.TeamId, userId: User.UserId) =>
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository — bulkInsert', () => {
  it.effect('bulkInsert creates one assignment per memberId defaulting to fee amount', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000001', 'assign-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910100000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id, 3000)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('assignments', ({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ assignments, fee }) =>
        Effect.sync(() => {
          expect(assignments).toHaveLength(1);
          expect(assignments[0]?.fee_id).toBe(fee.id);
          // Defaults to fee amount_minor when no override is provided
          expect(assignments[0]?.amount_minor).toBe(3000);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('bulkInsert is idempotent — second call with same memberIds does not error', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000002', 'assign-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910200000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.tap(({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      // Second call — must not error (ON CONFLICT DO NOTHING)
      Effect.bind('assignments', ({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ assignments }) =>
        Effect.sync(() => {
          // After two calls, still only one assignment
          expect(assignments).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('bulkInsert respects amountMinorOverride when provided', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000003', 'assign-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910300000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id, 5000)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('assignments', ({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.some(2500 as Fee.AmountMinor),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ assignments }) =>
        Effect.sync(() => {
          expect(assignments[0]?.amount_minor).toBe(2500);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeeAssignmentsRepository — update (waive / unwaive)', () => {
  it.effect('update waives an assignment — status from view becomes waived', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000004', 'assign-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910400000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('assignments', ({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('waived', ({ assignments }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignments[0]?.id, {
              waived: Option.some(true),
              waivedReason: Option.some(Option.some('Hardship exemption')),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ waived }) =>
        Effect.sync(() => {
          expect(waived.stored_status).toBe('waived');
          expect(Option.isSome(waived.waived_reason)).toBe(true);
          expect(Option.getOrNull(waived.waived_reason)).toBe('Hardship exemption');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('update unwaives back to active', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000005', 'assign-owner-5')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910500000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('assignments', ({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      // Waive first
      Effect.tap(({ assignments }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignments[0]?.id, {
              waived: Option.some(true),
              waivedReason: Option.some(Option.some('Temporary exemption')),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      // Then unwaive
      Effect.bind('unwaived', ({ assignments }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignments[0]?.id, {
              waived: Option.some(false),
              waivedReason: Option.none(),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ unwaived }) =>
        Effect.sync(() => {
          expect(unwaived.stored_status).toBe('active');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeeAssignmentsRepository — FK constraint on team_members delete', () => {
  it.effect('attempting to delete a team_member with assignments fails with FK violation', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000006', 'assign-owner-6')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910600000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.tap(({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      // Attempt raw delete of team_member — should throw due to RESTRICT FK
      Effect.bind('deleteResult', ({ member }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen(
            (repo) =>
              // Use raw delete via SQL — the TeamMembersRepository normally deactivates.
              // We attempt a hard delete which should fail due to FK.
              (repo as any).hardDelete((member as any).id) as Effect.Effect<void>,
          ),
          Effect.result,
        ),
      ),
      Effect.tap(({ deleteResult }) =>
        Effect.sync(() => {
          // Should be a Failure due to FK constraint violation
          expect(deleteResult._tag).toBe('Failure');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeeAssignmentsRepository — findByFee', () => {
  it.effect('findByFee returns assignments joined with member name', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000007', 'assign-owner-7')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910700000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.tap(({ fee, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('byFee', ({ fee }) =>
        FeeAssignmentsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findByFee(fee.id))),
      ),
      Effect.tap(({ byFee, fee }) =>
        Effect.sync(() => {
          expect(byFee).toHaveLength(1);
          expect(byFee[0]?.fee_id).toBe(fee.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FeeAssignmentsRepository — findByTeamMember', () => {
  it.effect('findByTeamMember returns assignments for a member across fees', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910000000000000008', 'assign-owner-8')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('910800000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee1', ({ team }) => createFee(team.id)),
      Effect.bind('fee2', ({ team }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              name: 'Second Fee',
              description: Option.none(),
              amount_minor: 2000,
              currency: 'EUR',
              due_at: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.tap(({ fee1, fee2, member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo.bulkInsert({
                feeId: fee1.id,
                memberIds: [(member as any).id],
                amountMinorOverride: Option.none(),
                dueAtOverride: Option.none(),
              }),
              repo.bulkInsert({
                feeId: fee2.id,
                memberIds: [(member as any).id],
                amountMinorOverride: Option.none(),
                dueAtOverride: Option.none(),
              }),
            ]),
          ),
        ),
      ),
      Effect.bind('byMember', ({ member }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamMember((member as any).id)),
        ),
      ),
      Effect.tap(({ byMember }) =>
        Effect.sync(() => {
          expect(byMember).toHaveLength(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
