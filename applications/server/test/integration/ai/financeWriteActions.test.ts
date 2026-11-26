// The AI assistant's finance write actions on real Postgres — the money path, so every rule is
// pinned against the real triggers and the real proposal claim, not the `finance.test.ts` mock
// harness. Harness mirrors `groupRosterWriteActions.test.ts`.
//
// Under test: propose writes ONLY the proposal row; confirm writes exactly what the card showed;
// a second Accept (sequential or concurrent) writes nothing more; the permission is checked at
// propose and at confirm; another team's fee, plan or ids are never reachable.

import { describe, expect, it } from '@effect/vitest';
import type {
  AiActionProposal,
  Discord,
  Fee,
  FeeAssignment,
  MembershipPlan,
  Team,
  TeamMember,
  User,
} from '@sideline/domain';
import { AiChatApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { AiChatApiLive } from '~/api/ai-chat.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { visibleTools } from '~/services/ai/registry.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { proposeAction } from '~/services/ai/writeTools.js';
import {
  assignMembershipPlanForMemberTx,
  recordPaymentForMemberTx,
} from '~/services/FinanceWrites.js';
import { LlmClient } from '~/services/LlmClient.js';
import { MockChatAgentLayer, MockChatRateLimiterLayer } from '../../mocks/aiChatMocks.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TrainingTypesRepository.Default,
  TeamSettingsRepository.Default,
  TeamChannelsRepository.Default,
  TeamChannelAccessRepository.Default,
  ChannelSyncEventsRepository.Default,
  DiscordChannelMappingRepository.Default,
  DiscordChannelsRepository.Default,
  BotGuildsRepository.Default,
  AiActionProposalsRepository.Default,
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  EventAttendanceRepository.Default,
  EventRsvpsRepository.Default,
  NotificationsRepository.Default,
  RostersRepository.Default,
  BankTransactionsRepository.Default,
  ExpensesRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  MembershipPlansRepository.Default,
  PaymentsRepository.Default,
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

const sessionsStore = new Map<string, User.UserId>();

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as never);

const HandlerLayer = HttpApiBuilder.layer(HttpApi.make('api').add(AiChatApi.AiChatApiGroup)).pipe(
  Layer.provide(AiChatApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockChatAgentLayer),
  Layer.provide(MockChatRateLimiterLayer),
  Layer.provide(LlmClient.Default),
  Layer.provide(Layer.succeed(AiChatEnabledConfig, { asEffect: Effect.succeed(true) })),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(HandlerLayer);
  handler = app.handler as (request: Request) => Promise<Response>;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore.clear();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const sf = (s: string) => s as Discord.Snowflake;

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: sf(discordId),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId, name: string) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
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

/** A member of `teamId` holding the built-in `roleName`, with a tool context and a token. */
const member = (
  teamId: Team.TeamId,
  discordId: string,
  roleName: 'Admin' | 'Captain' | 'Player' | 'Treasurer',
) =>
  Effect.gen(function* () {
    const userId = yield* createUser(discordId, `${roleName.toLowerCase()}-${discordId}`);
    const members = yield* TeamMembersRepository.asEffect();
    const tm = yield* members.addMember({
      team_id: teamId,
      user_id: userId,
      active: true,
      joined_at: undefined,
    });
    const roles = yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findRolesByTeamId(teamId)),
    );
    const role = roles.find((r) => r.name === roleName);
    if (!role) return yield* Effect.die(new Error(`built-in role ${roleName} not seeded`));
    yield* members.assignRole(tm.id, role.id);
    const token = `token-${discordId}`;
    sessionsStore.set(token, userId);
    const ctx = Effect.gen(function* () {
      const membership = yield* members
        .findMembershipByIds(teamId, userId)
        .pipe(Effect.map(Option.getOrThrow));
      const c: ToolContext = {
        teamId,
        membership,
        teamTimezone: 'Europe/Prague',
        canSeeGroup: () => Effect.succeed(true),
      };
      return c;
    });
    return { memberId: tm.id, roleId: role.id, token, ctx: yield* ctx };
  });

const insertFee = (teamId: Team.TeamId, name: string, memberId: TeamMember.TeamMemberId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [fee] = yield* sql<{ id: string }>`
      INSERT INTO fees (team_id, name, amount_minor, currency, target_scope)
      VALUES (${teamId}, ${name}, 150000, 'CZK', 'custom')
      RETURNING id::text AS id
    `;
    if (fee === undefined) return yield* Effect.die(new Error('fee not inserted'));
    const [assignment] = yield* sql<{ id: string }>`
      INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
      VALUES (${fee.id}, ${memberId}, 150000)
      RETURNING id::text AS id
    `;
    if (assignment === undefined) return yield* Effect.die(new Error('assignment not inserted'));
    return {
      feeId: fee.id as Fee.FeeId,
      assignmentId: assignment.id as FeeAssignment.FeeAssignmentId,
    };
  });

const insertPlan = (teamId: Team.TeamId, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [plan] = yield* sql<{ id: string }>`
      INSERT INTO membership_plans (team_id, name, currency, price_minor)
      VALUES (${teamId}, ${name}, 'CZK', 250000)
      RETURNING id::text AS id
    `;
    if (plan === undefined) return yield* Effect.die(new Error('plan not inserted'));
    return plan.id as MembershipPlan.MembershipPlanId;
  });

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ownerA = yield* createUser('910000000000000001', 'owner-a');
  const teamA = yield* createTeam(sf('910000000000000000'), ownerA, 'A team');
  const ownerB = yield* createUser('920000000000000001', 'owner-b');
  const teamB = yield* createTeam(sf('920000000000000000'), ownerB, 'B team');
  for (const t of [teamA, teamB]) {
    yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(t.id)),
    );
  }
  const admin = yield* member(teamA.id, '910000000000000900', 'Admin');
  const player = yield* member(teamA.id, '910000000000000902', 'Player');
  const captain = yield* member(teamA.id, '910000000000000903', 'Captain');
  const bPlayer = yield* member(teamB.id, '920000000000000902', 'Player');
  const springFee = yield* insertFee(teamA.id, 'Spring fee', player.memberId);
  // Team B's fee and plan: neither the name lookup nor their ids may reach them from team A.
  const bFee = yield* insertFee(teamB.id, 'B fee', bPlayer.memberId);
  const proPlan = yield* insertPlan(teamA.id, 'Pro');
  const bPlan = yield* insertPlan(teamB.id, 'B plan');
  return { sql, teamA, admin, player, captain, bPlayer, springFee, bFee, proPlan, bPlan };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const proposalCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM ai_action_proposals`;
  return row?.n;
});

const proposeOk = (action: AiActionProposal.AiActionName, args: unknown, ctx: ToolContext) =>
  proposeAction(action, args, ctx).pipe(
    Effect.map((outcome) => {
      const result = outcome.result as { status?: string; proposalId?: string };
      expect(result, JSON.stringify(outcome.result)).toMatchObject({ status: 'proposed' });
      return { proposalId: result.proposalId as string, summary: outcome.proposal?.summary ?? [] };
    }),
  );

const post = (url: string, token: string) =>
  Effect.promise(() =>
    handler(new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })),
  );

const confirm = (teamId: Team.TeamId, proposalId: string, token: string) =>
  post(`http://localhost/teams/${teamId}/ai/proposals/${proposalId}/confirm`, token);

const reject = (teamId: Team.TeamId, proposalId: string, token: string) =>
  post(`http://localhost/teams/${teamId}/ai/proposals/${proposalId}/reject`, token);

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>);

const payments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    amount_minor: number;
    method: string;
    paid_on: string;
    note: string | null;
    team_member_id: string;
    recorded_by_user_id: string;
  }>`
    SELECT amount_minor::int AS amount_minor, method, to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS paid_on,
           note, team_member_id::text AS team_member_id, recorded_by_user_id::text AS recorded_by_user_id
    FROM payments
  `;
});

const expenseCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM expenses`;
  return row?.n ?? 0;
});

const PLAYER = 'player-910000000000000902';

const PAYMENT_ARGS = {
  member: PLAYER,
  fee: 'Spring fee',
  amountMinor: 50000,
  method: 'cash',
  paidOn: '2026-03-14',
  note: 'paid at practice',
};

describe('AI finance write actions on real Postgres', () => {
  it.effect('visibleTools: a Player and a Captain see none of them; an Admin sees all three', () =>
    Effect.gen(function* () {
      const { admin, player, captain } = yield* setup;
      const names = (ctx: ToolContext) => visibleTools(ctx).map((t) => t.name);
      for (const t of [
        'propose_record_payment',
        'propose_create_expense',
        'propose_assign_membership_plan',
      ]) {
        expect(names(player.ctx)).not.toContain(t);
        expect(names(admin.ctx)).toContain(t);
      }
      // A Captain reads finance but may not write it.
      expect(names(captain.ctx)).not.toContain('propose_create_expense');
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('record_payment: propose writes nothing; confirm writes exactly the card', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, springFee } = yield* setup;
      const { proposalId, summary } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
      expect(summary.map((f) => [f.key, f.value])).toEqual([
        ['member', { type: 'text', value: PLAYER }],
        ['fee', { type: 'text', value: 'Spring fee' }],
        ['amount', { type: 'money', value: { amountMinor: 50000, currency: 'CZK' } }],
        ['date', { type: 'date', value: '2026-03-14' }],
        ['method', { type: 'paymentMethod', value: 'cash' }],
        ['note', { type: 'text', value: 'paid at practice' }],
      ]);
      expect(yield* payments).toHaveLength(0);

      const response = yield* confirm(teamA.id, proposalId, admin.token);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toEqual({ status: 'applied' });
      expect(yield* payments).toEqual([
        {
          amount_minor: 50000,
          method: 'cash',
          paid_on: '2026-03-14',
          note: 'paid at practice',
          team_member_id: player.memberId,
          recorded_by_user_id: admin.ctx.membership.user_id,
        },
      ]);
      // The trigger owns paid_minor; it saw exactly one payment.
      const [fa] = yield* sql<{ paid_minor: number }>`
        SELECT paid_minor::int AS paid_minor FROM fee_assignments WHERE id = ${springFee.assignmentId}
      `;
      expect(fa?.paid_minor).toBe(50000);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('record_payment: a second Accept answers 409 and records nothing more', () =>
    Effect.gen(function* () {
      const { teamA, admin } = yield* setup;
      const { proposalId } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(200);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(409);
      expect(yield* payments).toHaveLength(1);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('record_payment: two concurrent Accepts record ONE payment', () =>
    Effect.gen(function* () {
      const { teamA, admin } = yield* setup;
      const { proposalId } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
      const responses = yield* Effect.all(
        [confirm(teamA.id, proposalId, admin.token), confirm(teamA.id, proposalId, admin.token)],
        { concurrency: 'unbounded' },
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(yield* payments).toHaveLength(1);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('record_payment: reject records nothing and the proposal is gone', () =>
    Effect.gen(function* () {
      const { teamA, admin } = yield* setup;
      const { proposalId } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
      expect((yield* reject(teamA.id, proposalId, admin.token)).status).toBe(204);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(404);
      expect(yield* payments).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("record_payment: another team's fee is not found by name", () =>
    Effect.gen(function* () {
      const { admin } = yield* setup;
      const outcome = yield* proposeAction(
        'record_payment',
        { ...PAYMENT_ARGS, fee: 'B fee' },
        admin.ctx,
      );
      expect(outcome.result).toEqual({
        error: 'invalid_arguments',
        detail: 'fee: no active fee with that name',
      });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    "the shared payment write (HTTP and AI) refuses another team's fee and assignment",
    () =>
      Effect.gen(function* () {
        const { teamA, admin, springFee, bFee } = yield* setup;
        const payload = {
          amountMinor: 100 as Fee.AmountMinor,
          method: 'cash' as const,
          paidAt: DateTime.makeUnsafe('2026-03-14T12:00:00Z'),
          note: Option.none(),
        };
        const foreignFee = yield* recordPaymentForMemberTx({
          teamId: teamA.id,
          membership: admin.ctx.membership,
          feeId: bFee.feeId,
          assignmentId: bFee.assignmentId,
          payload,
        }).pipe(Effect.flip);
        expect(foreignFee._tag).toBe('FeeNotFound');
        // Own fee, foreign assignment: still refused.
        const foreignAssignment = yield* recordPaymentForMemberTx({
          teamId: teamA.id,
          membership: admin.ctx.membership,
          feeId: springFee.feeId,
          assignmentId: bFee.assignmentId,
          payload,
        }).pipe(Effect.flip);
        expect(foreignAssignment._tag).toBe('AssignmentNotFound');
        expect(yield* payments).toHaveLength(0);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('record_payment: refused when the fee currency changed after the card showed', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, springFee } = yield* setup;
      const { proposalId } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
      yield* sql`UPDATE fees SET currency = 'EUR' WHERE id = ${springFee.feeId}`;
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(404);
      expect(yield* payments).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'record_payment: a Player is refused at propose; confirm re-checks after the role loses the permission',
    () =>
      Effect.gen(function* () {
        const { sql, teamA, admin, player } = yield* setup;
        const refused = yield* proposeAction('record_payment', PAYMENT_ARGS, player.ctx);
        expect(refused.result).toEqual({
          error: 'forbidden',
          permission: 'finance:record_payments',
        });
        expect(yield* proposalCount).toBe(0);

        const { proposalId } = yield* proposeOk('record_payment', PAYMENT_ARGS, admin.ctx);
        yield* sql`DELETE FROM role_permissions WHERE role_id = ${admin.roleId} AND permission = 'finance:record_payments'`;
        expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(403);
        expect(yield* payments).toHaveLength(0);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('create_expense: confirm writes the card; a second Accept writes nothing more', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player } = yield* setup;
      const args = {
        amountMinor: 120000,
        currency: 'CZK',
        spentOn: '2026-03-10',
        category: 'fields',
        description: 'Field rent March',
      };
      const refused = yield* proposeAction('create_expense', args, player.ctx);
      expect(refused.result).toEqual({ error: 'forbidden', permission: 'finance:manage_fees' });

      const { proposalId, summary } = yield* proposeOk('create_expense', args, admin.ctx);
      expect(summary.map((f) => f.key)).toEqual(['amount', 'date', 'category', 'description']);
      expect(yield* expenseCount).toBe(0);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(200);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(409);
      const rows = yield* sql<{
        amount_minor: number;
        currency: string;
        spent_on: string;
        team_id: string;
      }>`
        SELECT amount_minor::int AS amount_minor, currency,
               to_char(spent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS spent_on, team_id::text AS team_id
        FROM expenses
      `;
      expect(rows).toEqual([
        { amount_minor: 120000, currency: 'CZK', spent_on: '2026-03-10', team_id: teamA.id },
      ]);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('create_expense: confirm re-checks the permission', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin } = yield* setup;
      const { proposalId } = yield* proposeOk(
        'create_expense',
        {
          amountMinor: 100,
          currency: 'CZK',
          spentOn: '2026-03-10',
          category: 'other',
          description: 'x',
        },
        admin.ctx,
      );
      yield* sql`DELETE FROM role_permissions WHERE role_id = ${admin.roleId} AND permission = 'finance:manage_fees'`;
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(403);
      expect(yield* expenseCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('assign_membership_plan: confirm moves the member; a second Accept is a 409', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, proPlan } = yield* setup;
      const { proposalId, summary } = yield* proposeOk(
        'assign_membership_plan',
        { member: PLAYER, plan: 'pro' },
        admin.ctx,
      );
      expect(summary.map((f) => [f.key, f.value])).toEqual([
        ['member', { type: 'text', value: PLAYER }],
        ['plan', { type: 'planName', value: 'Pro' }],
        ['amount', { type: 'money', value: { amountMinor: 250000, currency: 'CZK' } }],
        ['pricePerTraining', { type: 'money', value: { amountMinor: 0, currency: 'CZK' } }],
      ]);
      const planOf = sql<{ plan: string | null }>`
        SELECT membership_plan_id::text AS plan FROM team_members WHERE id = ${player.memberId}
      `;
      const before = (yield* planOf)[0]?.plan;
      expect(before).not.toBe(proPlan);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(200);
      expect((yield* planOf)[0]?.plan).toBe(proPlan);
      expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(409);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'assign_membership_plan: refused when the plan was repriced after the card showed',
    () =>
      Effect.gen(function* () {
        const { sql, teamA, admin, player, proPlan } = yield* setup;
        const { proposalId } = yield* proposeOk(
          'assign_membership_plan',
          { member: PLAYER, plan: 'Pro' },
          admin.ctx,
        );
        yield* sql`UPDATE membership_plans SET price_minor = 300000 WHERE id = ${proPlan}`;
        expect((yield* confirm(teamA.id, proposalId, admin.token)).status).toBe(404);
        const [row] = yield* sql<{ plan: string | null }>`
        SELECT membership_plan_id::text AS plan FROM team_members WHERE id = ${player.memberId}
      `;
        expect(row?.plan).not.toBe(proPlan);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("assign_membership_plan: another team's plan is unreachable by name and by id", () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, bPlayer, bPlan, proPlan } = yield* setup;
      const byName = yield* proposeAction(
        'assign_membership_plan',
        { member: PLAYER, plan: 'B plan' },
        admin.ctx,
      );
      expect(byName.result).toEqual({
        error: 'invalid_arguments',
        detail: 'plan: no active membership plan with that name',
      });
      const foreignPlan = yield* assignMembershipPlanForMemberTx({
        teamId: teamA.id,
        membership: admin.ctx.membership,
        memberId: player.memberId,
        membershipPlanId: Option.some(bPlan),
      }).pipe(Effect.flip);
      expect(foreignPlan._tag).toBe('MembershipPlanNotFound');
      const foreignMember = yield* assignMembershipPlanForMemberTx({
        teamId: teamA.id,
        membership: admin.ctx.membership,
        memberId: bPlayer.memberId,
        membershipPlanId: Option.some(proPlan),
      }).pipe(Effect.flip);
      expect(foreignMember._tag).toBe('MembershipPlanNotFound');
      const moved = yield* sql`
        SELECT 1 FROM team_members WHERE membership_plan_id IN (${bPlan}, ${proPlan})
      `;
      expect(moved).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('assign_membership_plan: a Player is refused at propose', () =>
    Effect.gen(function* () {
      const { player } = yield* setup;
      const refused = yield* proposeAction(
        'assign_membership_plan',
        { member: PLAYER, plan: 'Pro' },
        player.ctx,
      );
      expect(refused.result).toEqual({ error: 'forbidden', permission: 'finance:manage_fees' });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );
});
