// `findByTeamMember` feeds both `finance.myStatus` (a member's own My Payments page) and
// `finance.listMemberAssignments` (a treasurer looking at one member). It was the last money
// read path that ignored `fees.archived_at`, so an archived fee kept reading as due forever
// with no way for a member to clear it — the symptom that produced this test.
//
// The carve-out is `paid_minor > 0`: what a member actually paid stays visible as history,
// because dropping archived fees outright would erase last season's dues from their own record.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Archived My Payments Test Team',
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

const createFee = (teamId: Team.TeamId, name: string, amountMinor = 1000) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
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
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createAssignment = (feeId: Fee.FeeId, memberId: string, amountMinor?: number) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.bulkInsert({
        feeId,
        memberIds: [memberId as never],
        amountMinorOverride: amountMinor
          ? Option.some(amountMinor as Fee.AmountMinor)
          : Option.none(),
        dueAtOverride: Option.some(DateTime.fromDateUnsafe(new Date('2026-01-01T00:00:00Z'))),
      }),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (row === undefined) throw new Error('bulkInsert did not return an assignment');
      return row;
    }),
  );

const archiveFee = (feeId: Fee.FeeId) =>
  FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(feeId)));

const pay = (assignmentId: string, memberId: string, amountMinor: number, userId: User.UserId) =>
  PaymentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        feeAssignmentId: assignmentId as never,
        teamMemberId: memberId as never,
        amountMinor,
        method: 'bank_transfer',
        paidAt: DateTime.fromDateUnsafe(new Date('2026-01-02T00:00:00Z')),
        note: Option.none(),
        recordedByUserId: userId,
      }),
    ),
  );

const setup = Effect.gen(function* () {
  const userId = yield* createUser('700000000000000001', 'archived-mypayments-user');
  const team = yield* createTeam('800000000000000001' as Discord.Snowflake, userId);
  const member = yield* addMember(team.id, userId);
  return { userId, teamId: team.id, memberId: member.id };
});

describe('findByTeamMember — archived fees', () => {
  it.effect('hides an unpaid assignment once its fee is archived', () =>
    Effect.gen(function* () {
      const { teamId, memberId } = yield* setup;
      const fee = yield* createFee(teamId, 'Testovaci fee');
      yield* createAssignment(fee.id, memberId);

      const repo = yield* FeeAssignmentsRepository.asEffect();

      const before = yield* repo.findByTeamMember(memberId);
      expect(before).toHaveLength(1);

      yield* archiveFee(fee.id);

      const after = yield* repo.findByTeamMember(memberId);
      expect(after).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('keeps a paid assignment visible after its fee is archived', () =>
    Effect.gen(function* () {
      const { userId, teamId, memberId } = yield* setup;
      const fee = yield* createFee(teamId, 'Last season dues');
      const assignment = yield* createAssignment(fee.id, memberId);
      yield* pay(assignment.id, memberId, 1000, userId);

      yield* archiveFee(fee.id);

      const repo = yield* FeeAssignmentsRepository.asEffect();
      const rows = yield* repo.findByTeamMember(memberId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.computed_status).toBe('paid');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('keeps a partially paid assignment visible after its fee is archived', () =>
    Effect.gen(function* () {
      const { userId, teamId, memberId } = yield* setup;
      const fee = yield* createFee(teamId, 'Partly paid dues');
      const assignment = yield* createAssignment(fee.id, memberId);
      yield* pay(assignment.id, memberId, 400, userId);

      yield* archiveFee(fee.id);

      const repo = yield* FeeAssignmentsRepository.asEffect();
      const rows = yield* repo.findByTeamMember(memberId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.computed_status).toBe('partial');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaves assignments on non-archived fees untouched', () =>
    Effect.gen(function* () {
      const { teamId, memberId } = yield* setup;
      const live = yield* createFee(teamId, 'Live fee');
      const archived = yield* createFee(teamId, 'Archived fee');
      yield* createAssignment(live.id, memberId);
      yield* createAssignment(archived.id, memberId);

      yield* archiveFee(archived.id);

      const repo = yield* FeeAssignmentsRepository.asEffect();
      const rows = yield* repo.findByTeamMember(memberId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.fee_name).toBe('Live fee');
    }).pipe(Effect.provide(TestLayer)),
  );
});
