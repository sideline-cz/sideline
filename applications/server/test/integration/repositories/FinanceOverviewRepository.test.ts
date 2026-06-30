// TDD mode — tests written BEFORE FinanceOverviewRepository implementation exists.
// These tests WILL FAIL until the developer implements FinanceOverviewRepository.
//
// Required implementation:
//   - applications/server/src/repositories/FeesRepository.ts
//   - applications/server/src/repositories/FeeAssignmentsRepository.ts
//   - applications/server/src/repositories/PaymentsRepository.ts
//   - applications/server/src/repositories/FinanceOverviewRepository.ts

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FinanceOverviewRepository.Default,
  PaymentsRepository.Default,
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
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Overview Test Team',
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

const createFee = (teamId: Team.TeamId, amountMinor: number, currency: string) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: `Fee in ${currency}`,
        description: Option.none(),
        amount_minor: amountMinor,
        currency,
        due_at: Option.none(),
      }),
    ),
  );

const assignFee = (feeId: Fee.FeeId, memberId: string) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.bulkInsert({
        feeId,
        memberIds: [memberId as any],
        amountMinorOverride: Option.none(),
        dueAtOverride: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FinanceOverviewRepository — overviewByTeam', () => {
  it.effect('returns per-currency rows per member (CZK + EUR → 2 rows)', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000001', 'overview-user-1')),
      Effect.bind('team', ({ user }) =>
        createTeam('930100000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('czFee', ({ team }) => createFee(team.id, 5000, 'CZK')),
      Effect.bind('eurFee', ({ team }) => createFee(team.id, 1000, 'EUR')),
      Effect.tap(({ czFee, member }) => assignFee(czFee.id, (member as any).id)),
      Effect.tap(({ eurFee, member }) => assignFee(eurFee.id, (member as any).id)),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          // One row per currency
          expect(memberRows).toHaveLength(2);
          const currencies = memberRows.map((r) => r.currency).sort();
          expect(currencies).toEqual(['CZK', 'EUR']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member with no fees is not in result', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000002', 'overview-user-2')),
      Effect.bind('team', ({ user }) =>
        createTeam('930200000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      // No fees assigned
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          expect(memberRows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('waived assignment is excluded from totalDueMinor and totalPaidMinor', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000003', 'overview-user-3')),
      Effect.bind('team', ({ user }) =>
        createTeam('930300000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('fee', ({ team }) => createFee(team.id, 5000, 'CZK')),
      Effect.bind('assignments', ({ fee, member }) => assignFee(fee.id, (member as any).id)),
      // Waive the assignment
      Effect.tap(({ assignments }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignments[0]?.id, {
              waived: Option.some(true),
              waivedReason: Option.some(Option.some('Scholarship')),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          // Waived assignments should not contribute to totals
          // Member may not appear at all, or if they do, totals should be 0
          if (memberRows.length > 0) {
            expect(memberRows[0]?.totalDueMinor ?? 0).toBe(0);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('multiple fees same currency aggregate correctly: 500 + 700 = 1200 totalDueMinor', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000004', 'overview-user-4')),
      Effect.bind('team', ({ user }) =>
        createTeam('930400000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('fee1', ({ team }) => createFee(team.id, 500, 'CZK')),
      Effect.bind('fee2', ({ team }) => createFee(team.id, 700, 'CZK')),
      Effect.tap(({ fee1, member }) => assignFee(fee1.id, (member as any).id)),
      Effect.tap(({ fee2, member }) => assignFee(fee2.id, (member as any).id)),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberCzkRows = overview.filter(
            (r) => r.teamMemberId === (member as any).id && r.currency === 'CZK',
          );
          expect(memberCzkRows).toHaveLength(1);
          expect(memberCzkRows[0]?.totalDueMinor).toBe(1200);
          expect(memberCzkRows[0]?.totalPaidMinor).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
