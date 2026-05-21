import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PaymentRemindersSentRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers — create minimal fixture data
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
        name: 'Sent Repo Test Team',
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

const createFeeAndAssignment = (teamId: Team.TeamId, memberId: string) =>
  Effect.Do.pipe(
    Effect.bind('fee', () =>
      FeesRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insert({
            team_id: teamId,
            name: 'Test Fee',
            description: Option.none(),
            amount_minor: 5000,
            currency: 'CZK',
            due_at: Option.none(),
          }),
        ),
      ),
    ),
    Effect.bind('assignments', ({ fee }) =>
      FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.bulkInsert({
            feeId: fee.id,
            memberIds: [memberId as any],
            amountMinorOverride: Option.none(),
            dueAtOverride: Option.none(),
          }),
        ),
      ),
    ),
    Effect.map(({ assignments }) => assignments[0]!),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentRemindersSentRepository', () => {
  it.effect('markSent inserts a row for (assignment_id, kind)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('930000000000000001', 'sent-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('930100000000000000' as Discord.Snowflake, ownerId),
      ),
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
      Effect.bind('assignment', ({ team, member }) =>
        createFeeAndAssignment(team.id, (member as any).id),
      ),
      Effect.tap(({ assignment }) =>
        PaymentRemindersSentRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markSent(assignment.id, 'due_today')),
        ),
      ),
      Effect.bind('exists', ({ assignment }) =>
        PaymentRemindersSentRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.existsForAssignmentKind(assignment.id, 'due_today')),
        ),
      ),
      Effect.tap(({ exists }) =>
        Effect.sync(() => {
          expect(exists).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'second call to markSent for same (assignment_id, kind) is a no-op (ON CONFLICT DO NOTHING)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('930000000000000002', 'sent-owner-2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('930200000000000000' as Discord.Snowflake, ownerId),
        ),
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
        Effect.bind('assignment', ({ team, member }) =>
          createFeeAndAssignment(team.id, (member as any).id),
        ),
        // First call
        Effect.tap(({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.markSent(assignment.id, 'due_in_3d')),
          ),
        ),
        // Second call — must NOT error
        Effect.tap(({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.markSent(assignment.id, 'due_in_3d')),
          ),
        ),
        // Still only one row — exists returns true
        Effect.bind('exists', ({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.existsForAssignmentKind(assignment.id, 'due_in_3d')),
          ),
        ),
        Effect.tap(({ exists }) =>
          Effect.sync(() => {
            expect(exists).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('existsForAssignmentKind returns false when no row exists', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('930000000000000003', 'sent-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('930300000000000000' as Discord.Snowflake, ownerId),
      ),
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
      Effect.bind('assignment', ({ team, member }) =>
        createFeeAndAssignment(team.id, (member as any).id),
      ),
      Effect.bind('existsBefore', ({ assignment }) =>
        PaymentRemindersSentRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.existsForAssignmentKind(assignment.id, 'overdue_3d')),
        ),
      ),
      Effect.tap(({ existsBefore }) =>
        Effect.sync(() => {
          expect(existsBefore).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'existsForAssignmentKind is kind-specific — sent for one kind does not affect another',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('930000000000000004', 'sent-owner-4')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('930400000000000000' as Discord.Snowflake, ownerId),
        ),
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
        Effect.bind('assignment', ({ team, member }) =>
          createFeeAndAssignment(team.id, (member as any).id),
        ),
        // Mark sent for due_today only
        Effect.tap(({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.markSent(assignment.id, 'due_today')),
          ),
        ),
        Effect.bind('dueTodayExists', ({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.existsForAssignmentKind(assignment.id, 'due_today')),
          ),
        ),
        Effect.bind('overdue3dExists', ({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.existsForAssignmentKind(assignment.id, 'overdue_3d')),
          ),
        ),
        Effect.tap(({ dueTodayExists, overdue3dExists }) =>
          Effect.sync(() => {
            expect(dueTodayExists).toBe(true);
            expect(overdue3dExists).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
