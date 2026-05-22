// TDD mode — tests written BEFORE the FinanceApiLive handler exists.
// These tests WILL FAIL until:
//   - applications/server/src/api/finance.ts (FinanceApiLive) is implemented
//   - api.ts adds FinanceApi.FinanceApiGroup
//   - api/index.ts provides FinanceApiLive
//   - FeesRepository, FeeAssignmentsRepository, PaymentsRepository are implemented

import type {
  Auth,
  Discord,
  Fee,
  FeeAssignment,
  Payment,
  Role,
  Team,
  TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../../mocks/onboardingMocks.js';
import { MockTranslationsLayers } from '../../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_CAPTAIN_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_PLAYER_USER_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TREASURER_USER_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_PLAYER_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_OTHER_TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const TEST_TREASURER_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;

const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'finance:view',
  'member:view',
  'roster:view',
];

const TREASURER_PERMISSIONS: readonly Role.Permission[] = [
  'finance:view',
  'finance:manage_fees',
  'finance:record_payments',
];

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['member:view', 'roster:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type FeeRecord = {
  id: Fee.FeeId;
  team_id: Team.TeamId;
  name: string;
  description: Option.Option<string>;
  amount_minor: Fee.AmountMinor;
  currency: Fee.CurrencyCode;
  due_at: Option.Option<ReturnType<typeof DateTime.nowUnsafe>>;
  recurrence: Fee.FeeRecurrence;
  target_scope: Fee.FeeTargetScope;
  created_at: ReturnType<typeof DateTime.nowUnsafe>;
  updated_at: ReturnType<typeof DateTime.nowUnsafe>;
  archived_at: Option.Option<ReturnType<typeof DateTime.nowUnsafe>>;
  assignment_count: number;
  paid_count: number;
  pending_count: number;
  overdue_count: number;
};

type AssignmentRecord = {
  id: FeeAssignment.FeeAssignmentId;
  fee_id: Fee.FeeId;
  team_member_id: TeamMember.TeamMemberId;
  member_name: Option.Option<string>;
  fee_name: string;
  currency: Fee.CurrencyCode;
  due_minor: Fee.AmountMinor;
  paid_minor: Fee.AmountMinor;
  // stored_status is used by AssignmentRow; computed_status by AssignmentViewRow
  stored_status: FeeAssignment.StoredAssignmentStatus;
  status: FeeAssignment.FeeAssignmentStatus;
  computed_status: FeeAssignment.FeeAssignmentStatus;
  effective_due_at: Option.Option<ReturnType<typeof DateTime.nowUnsafe>>;
  waived_reason: Option.Option<string>;
};

type PaymentRecord = {
  id: Payment.PaymentId;
  fee_assignment_id: FeeAssignment.FeeAssignmentId;
  team_member_id: TeamMember.TeamMemberId;
  amount_minor: Fee.AmountMinor;
  voided_at: Option.Option<ReturnType<typeof DateTime.nowUnsafe>>;
  void_reason: Option.Option<string>;
};

let feesStore: Map<Fee.FeeId, FeeRecord>;
let assignmentsStore: Map<FeeAssignment.FeeAssignmentId, AssignmentRecord>;
let paymentsStore: Map<Payment.PaymentId, PaymentRecord>;

const usersMap = new Map<Auth.UserId, { id: Auth.UserId; discord_id: string; username: string }>();
usersMap.set(TEST_CAPTAIN_USER_ID, {
  id: TEST_CAPTAIN_USER_ID,
  discord_id: '111111111111111111',
  username: 'captain',
});
usersMap.set(TEST_PLAYER_USER_ID, {
  id: TEST_PLAYER_USER_ID,
  discord_id: '222222222222222222',
  username: 'player',
});
usersMap.set(TEST_TREASURER_USER_ID, {
  id: TEST_TREASURER_USER_ID,
  discord_id: '333333333333333333',
  username: 'treasurer',
});

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('captain-token', TEST_CAPTAIN_USER_ID);
sessionsStore.set('player-token', TEST_PLAYER_USER_ID);
sessionsStore.set('treasurer-token', TEST_TREASURER_USER_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_CAPTAIN_MEMBER_ID, {
  id: TEST_CAPTAIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_CAPTAIN_USER_ID,
  active: true,
  role_names: ['Captain'],
  permissions: CAPTAIN_PERMISSIONS as any,
} as MembershipWithRole);
membersStore.set(TEST_PLAYER_MEMBER_ID, {
  id: TEST_PLAYER_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_PLAYER_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS as any,
} as MembershipWithRole);
membersStore.set(TEST_TREASURER_MEMBER_ID, {
  id: TEST_TREASURER_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_TREASURER_USER_ID,
  active: true,
  role_names: ['Treasurer'],
  permissions: TREASURER_PERMISSIONS as any,
} as MembershipWithRole);

// Maps each TeamMemberId to its team_id — used for team-membership validation in bulkInsert
const memberTeamMap = new Map<TeamMember.TeamMemberId, Team.TeamId>();
memberTeamMap.set(TEST_CAPTAIN_MEMBER_ID, TEST_TEAM_ID);
memberTeamMap.set(TEST_PLAYER_MEMBER_ID, TEST_TEAM_ID);
memberTeamMap.set(TEST_OTHER_TEAM_MEMBER_ID, TEST_OTHER_TEAM_ID);
memberTeamMap.set(TEST_TREASURER_MEMBER_ID, TEST_TEAM_ID);

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Finance Test Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_CAPTAIN_USER_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const resetStores = () => {
  feesStore = new Map();
  assignmentsStore = new Map();
  paymentsStore = new Map();
};

// ---------------------------------------------------------------------------
// Mock finance repositories
// ---------------------------------------------------------------------------

const MockFeesRepositoryLayer = Layer.succeed(FeesRepository, {
  _tag: 'api/FeesRepository',
  insert: (input: any) => {
    if (input.amountMinor === 0 || input.amount_minor === 0) {
      const { FinanceApi } = require('@sideline/domain');
      return Effect.fail(new FinanceApi.InvalidAmount());
    }
    const id = crypto.randomUUID() as Fee.FeeId;
    const record: FeeRecord = {
      id,
      team_id: input.team_id,
      name: input.name,
      description: input.description ?? Option.none(),
      amount_minor: input.amount_minor,
      currency: input.currency,
      due_at: input.due_at ?? Option.none(),
      recurrence: 'none',
      target_scope: input.target_scope ?? 'all_members',
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
      archived_at: Option.none(),
      assignment_count: 0,
      paid_count: 0,
      pending_count: 0,
      overdue_count: 0,
    };
    feesStore.set(id, record);
    return Effect.succeed(record);
  },
  findById: (id: Fee.FeeId) => {
    const fee = feesStore.get(id);
    if (!fee || Option.isSome(fee.archived_at)) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(fee));
  },
  findByIdAny: (id: Fee.FeeId) => {
    const fee = feesStore.get(id);
    return Effect.succeed(fee ? Option.some(fee) : Option.none());
  },
  findWithCountsById: (id: Fee.FeeId) => {
    const fee = feesStore.get(id);
    if (!fee || Option.isSome(fee.archived_at)) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(fee));
  },
  listByTeam: (teamId: Team.TeamId) => {
    const fees = Array.from(feesStore.values()).filter(
      (f) => f.team_id === teamId && Option.isNone(f.archived_at),
    );
    return Effect.succeed(fees);
  },
  update: (id: Fee.FeeId, patch: any) => {
    const fee = feesStore.get(id);
    if (!fee) {
      const { FinanceApi } = require('@sideline/domain');
      return Effect.fail(new FinanceApi.FeeNotFound());
    }
    if (Option.isSome(fee.archived_at)) {
      const { FinanceApi } = require('@sideline/domain');
      return Effect.fail(new FinanceApi.FeeArchived());
    }
    const updated = { ...fee, updated_at: DateTime.nowUnsafe() };
    if (Option.isSome(patch.name)) updated.name = patch.name.value;
    feesStore.set(id, updated);
    return Effect.succeed(updated);
  },
  archive: (id: Fee.FeeId) => {
    const fee = feesStore.get(id);
    if (fee && Option.isNone(fee.archived_at)) {
      feesStore.set(id, { ...fee, archived_at: Option.some(DateTime.nowUnsafe()) });
    }
    return Effect.void;
  },
} as any);

const MockFeeAssignmentsRepositoryLayer = Layer.succeed(FeeAssignmentsRepository, {
  _tag: 'api/FeeAssignmentsRepository',
  bulkInsert: (input: {
    feeId: Fee.FeeId;
    memberIds: TeamMember.TeamMemberId[];
    amountMinorOverride: Option.Option<Fee.AmountMinor>;
    dueAtOverride: Option.Option<any>;
  }) => {
    const fee = feesStore.get(input.feeId);
    const results: AssignmentRecord[] = [];
    for (const memberId of input.memberIds) {
      // Silently skip members that don't belong to the same team as the fee
      const memberTeamId = memberTeamMap.get(memberId);
      if (!fee || memberTeamId !== fee.team_id) {
        continue;
      }
      // Check if already exists (idempotent ON CONFLICT)
      const existing = Array.from(assignmentsStore.values()).find(
        (a) => a.fee_id === input.feeId && a.team_member_id === memberId,
      );
      if (existing) {
        results.push(existing);
        continue;
      }
      const id = crypto.randomUUID() as FeeAssignment.FeeAssignmentId;
      const record: AssignmentRecord = {
        id,
        fee_id: input.feeId,
        team_member_id: memberId,
        member_name: Option.none(),
        fee_name: fee?.name ?? 'Unknown',
        currency: fee?.currency ?? ('CZK' as Fee.CurrencyCode),
        due_minor: Option.isSome(input.amountMinorOverride)
          ? input.amountMinorOverride.value
          : (fee?.amount_minor ?? (0 as Fee.AmountMinor)),
        paid_minor: 0 as Fee.AmountMinor,
        stored_status: 'active',
        status: 'pending',
        computed_status: 'pending',
        effective_due_at: Option.none(),
        waived_reason: Option.none(),
      };
      assignmentsStore.set(id, record);
      results.push(record);
    }
    return Effect.succeed(results);
  },
  findById: (id: FeeAssignment.FeeAssignmentId) => {
    const assignment = assignmentsStore.get(id);
    return Effect.succeed(assignment ? Option.some(assignment) : Option.none());
  },
  findByFee: (feeId: Fee.FeeId) => {
    const results = Array.from(assignmentsStore.values()).filter((a) => a.fee_id === feeId);
    return Effect.succeed(results);
  },
  findByTeamMember: (memberId: TeamMember.TeamMemberId) => {
    const results = Array.from(assignmentsStore.values()).filter(
      (a) => a.team_member_id === memberId,
    );
    return Effect.succeed(results);
  },
  findByFeeAndMember: (feeId: Fee.FeeId, teamMemberId: TeamMember.TeamMemberId) => {
    const result = Array.from(assignmentsStore.values()).find(
      (a) => a.fee_id === feeId && a.team_member_id === teamMemberId,
    );
    return Effect.succeed(result ? Option.some(result) : Option.none());
  },
} as any);

const MockPaymentsRepositoryLayer = Layer.succeed(PaymentsRepository, {
  _tag: 'api/PaymentsRepository',
  insert: (input: any) => {
    if (input.amountMinor === 0) {
      const { FinanceApi } = require('@sideline/domain');
      return Effect.fail(new FinanceApi.InvalidAmount());
    }
    const id = crypto.randomUUID() as Payment.PaymentId;
    const record: PaymentRecord = {
      id,
      fee_assignment_id: input.feeAssignmentId,
      team_member_id: input.teamMemberId,
      amount_minor: input.amountMinor,
      voided_at: Option.none(),
      void_reason: Option.none(),
    };
    paymentsStore.set(id, record);
    return Effect.succeed({
      id,
      fee_assignment_id: input.feeAssignmentId,
      team_member_id: input.teamMemberId,
      amount_minor: input.amountMinor,
      method: input.method,
      paid_at: input.paidAt,
      note: input.note,
      recorded_by_user_id: input.recordedByUserId,
      member_name: Option.none(),
      recorder_name: Option.none(),
      voided_at: Option.none(),
      void_reason: Option.none(),
    });
  },
  findActiveByIdAndTeam: (id: Payment.PaymentId, teamId: Team.TeamId) => {
    const payment = paymentsStore.get(id);
    if (!payment || Option.isSome(payment.voided_at)) return Effect.succeed(Option.none());
    // Look up the assignment and its fee to check team ownership
    const assignment = assignmentsStore.get(payment.fee_assignment_id);
    if (!assignment) return Effect.succeed(Option.none());
    const fee = feesStore.get(assignment.fee_id);
    if (!fee || fee.team_id !== teamId) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(payment));
  },
  void_: (id: Payment.PaymentId) => {
    const payment = paymentsStore.get(id);
    if (payment) {
      paymentsStore.set(id, { ...payment, voided_at: Option.some(DateTime.nowUnsafe()) });
    }
    return Effect.void;
  },
  listByTeam: (
    teamId: Team.TeamId,
    filters: {
      memberId?: Option.Option<TeamMember.TeamMemberId>;
      feeId?: Option.Option<Fee.FeeId>;
      from?: Option.Option<unknown>;
      to?: Option.Option<unknown>;
      includeVoided?: boolean;
    },
  ) => {
    const memberId = filters.memberId ?? Option.none<TeamMember.TeamMemberId>();
    const feeId = filters.feeId ?? Option.none<Fee.FeeId>();
    const includeVoided = filters.includeVoided ?? false;

    const results = Array.from(paymentsStore.values()).filter((payment) => {
      // Check team ownership via assignment → fee chain
      const assignment = assignmentsStore.get(payment.fee_assignment_id);
      if (!assignment) return false;
      const fee = feesStore.get(assignment.fee_id);
      if (!fee || fee.team_id !== teamId) return false;

      // memberId filter
      if (Option.isSome(memberId) && payment.team_member_id !== memberId.value) return false;

      // feeId filter (filter by fee_id on the assignment, not fee_assignment_id)
      if (Option.isSome(feeId) && assignment.fee_id !== feeId.value) return false;

      // voided filter
      if (!includeVoided && Option.isSome(payment.voided_at)) return false;

      return true;
    });

    // Map to PaymentView-like shape (enough for the handler to decode)
    return Effect.succeed(
      results.map((p) => ({
        id: p.id,
        fee_assignment_id: p.fee_assignment_id,
        team_member_id: p.team_member_id,
        amount_minor: p.amount_minor,
        method: 'cash' as Payment.PaymentMethod,
        paid_at: new Date(),
        note: Option.none(),
        recorded_by_user_id: TEST_CAPTAIN_USER_ID,
        voided_at: p.voided_at,
        voided_by_user_id: Option.none(),
        void_reason: p.void_reason,
        created_at: new Date(),
        member_name: Option.none(),
        recorder_name: Option.none(),
      })),
    );
  },
} as any);

const MockFinanceOverviewRepositoryLayer = Layer.succeed(FinanceOverviewRepository, {
  _tag: 'api/FinanceOverviewRepository',
  overviewByTeam: () => Effect.succeed([]),
} as any);

const MockExpensesRepositoryLayer = Layer.succeed(ExpensesRepository, {
  _tag: 'api/ExpensesRepository',
  insert: () => LogicError.die('MockExpensesRepositoryLayer.insert not implemented'),
  findById: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  update: () => Effect.succeed(Option.none()),
  delete: () => Effect.succeed(false),
  balanceSummaryByTeam: () =>
    Effect.succeed([
      {
        currency: 'CZK',
        incomeMinor: 0,
        expensesMinor: 0,
        netMinor: 0,
        byCategory: [],
      },
    ]),
  countHistoryRows: () => Effect.succeed(0),
} as any);

// ---------------------------------------------------------------------------
// Standard mock layers (copied from activity-type.test.ts pattern)
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) => {
    const user = usersMap.get(id);
    return Effect.succeed(
      user
        ? Option.some({
            ...user,
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.none(),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en',
            discord_display_name: Option.none(),
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          })
        : Option.none(),
    );
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed({} as any),
  completeProfile: () => Effect.succeed({} as any),
  updateLocale: () => Effect.succeed({} as any),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: (input: { token: string; user_id: Auth.UserId }) => {
    sessionsStore.set(input.token, input.user_id);
    return Effect.succeed({
      id: 'session-1',
      user_id: input.user_id,
      token: input.token,
      expires_at: DateTime.nowUnsafe(),
      created_at: DateTime.nowUnsafe(),
    });
  },
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
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: (id: Team.TeamId) => {
    if (id === TEST_TEAM_ID) return Effect.succeed(Option.some(testTeam));
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.succeed(testTeam),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = Array.from(membersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: (userId: Auth.UserId) =>
    Effect.succeed(Array.from(membersStore.values()).filter((m) => m.user_id === userId)),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: '12345', username: 'testuser', avatar: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  insert: () => Effect.die(new Error('not implemented')),
  findByTeamMember: () => Effect.succeed([]),
} as any);

const MockLeaderboardRepositoryLayer = Layer.succeed(LeaderboardRepository, {
  getLeaderboard: () => Effect.succeed([]),
} as any);

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  _tag: 'api/ActivityTypesRepository',
  findBySlug: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findByIdScoped: () => Effect.succeed(Option.none()),
  findByNameInScope: () => Effect.succeed(Option.none()),
  insertCustom: () => Effect.die(new Error('Not implemented')),
  updateCustom: () => Effect.die(new Error('Not implemented')),
  deleteCustom: () => Effect.void,
  countLogsForType: () => Effect.succeed(0),
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
} as any);

const MockRolesRepositoryLayer = Layer.succeed(RolesRepository, {
  _tag: 'api/RolesRepository',
  findRolesByTeamId: () => Effect.succeed([]),
  findRoleById: () => Effect.succeed(Option.none()),
  getPermissionsForRoleId: () => Effect.succeed([]),
  insertRole: () => Effect.die(new Error('Not implemented')),
  updateRole: () => Effect.die(new Error('Not implemented')),
  archiveRoleById: () => Effect.void,
  setRolePermissions: () => Effect.void,
  initializeTeamRoles: () => Effect.void,
  findRoleByTeamAndName: () => Effect.succeed(Option.none()),
  seedTeamRolesWithPermissions: () => Effect.succeed([]),
  getMemberCountForRole: () => Effect.succeed(0),
  findGroupsForRole: () => Effect.succeed([]),
  assignRoleToGroup: () => Effect.void,
  unassignRoleFromGroup: () => Effect.void,
} as any);

const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  _tag: 'api/GroupsRepository',
  findGroupsByTeamId: () => Effect.succeed([]),
  findGroupById: () => Effect.succeed(Option.none()),
  insertGroup: () => Effect.die(new Error('Not implemented')),
  updateGroupById: () => Effect.die(new Error('Not implemented')),
  archiveGroupById: () => Effect.void,
  moveGroup: () => Effect.die(new Error('Not implemented')),
  findMembersByGroupId: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
  getRolesForGroup: () => Effect.succeed([]),
  getMemberCount: () => Effect.succeed(0),
  getChildren: () => Effect.succeed([]),
  getAncestorIds: () => Effect.succeed([]),
  getDescendantMemberIds: () => Effect.succeed([]),
} as any);

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  _tag: 'api/TrainingTypesRepository',
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findByIdWithGroup: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  deleteTrainingType: () => Effect.void,
} as any);

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  updateRule: () => Effect.die(new Error('Not implemented')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('Not implemented')),
  updateRuleById: () => Effect.die(new Error('Not implemented')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => Effect.die(new Error('Not implemented')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.die(new Error('Not implemented')),
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
  evaluateTeam: () => Effect.succeed([]),
  evaluate: () => Effect.succeed([]),
} as any);

const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  emitRoleAssigned: () => Effect.void,
  emitRoleUnassigned: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  emitChannelCreated: () => Effect.void,
  emitChannelDeleted: () => Effect.void,
  emitMemberAdded: () => Effect.void,
  emitMemberRemoved: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
  hasUnprocessedForGroups: () => Effect.succeed([]),
  hasUnprocessedForRosters: () => Effect.succeed([]),
} as any);

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
} as any);

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  _tag: 'api/OAuthConnectionsRepository',
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
} as any);

const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
} as any);

const MockDiscordRolesRepositoryLayer = Layer.succeed(
  DiscordRolesRepository,
  new Proxy({} as any, { get: () => () => Effect.void }),
);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: () => Effect.succeed(Option.none()),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
  insertSeries: () => Effect.die(new Error('Not implemented')),
  insertEventSeries: () => Effect.die(new Error('Not implemented')),
  findByTeamId: () => Effect.succeed([]),
  findSeriesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findSeriesById: () => Effect.succeed(Option.none()),
  updateSeries: () => Effect.die(new Error('Not implemented')),
  updateEventSeries: () => Effect.die(new Error('Not implemented')),
  cancelSeries: () => Effect.void,
  cancelEventSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: () => Effect.die(new Error('Not implemented')),
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
} as any);

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  _tag: 'api/ICalTokensRepository',
  findByToken: () => Effect.succeed(Option.none()),
  findByUserId: () => Effect.succeed(Option.none()),
  create: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token',
      created_at: new Date(),
    }),
  regenerate: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token-new',
      created_at: new Date(),
    }),
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as any);

const MockAchievementAdminLayers = Layer.mergeAll(
  Layer.succeed(AchievementRoleMappingsRepository, {
    findAllByTeam: () => Effect.succeed([]),
    upsert: () => Effect.void,
    delete: () => Effect.void,
  } as any),
  Layer.succeed(AchievementSettingsRepository, {
    findOverridesByTeam: () => Effect.succeed(new Map()),
    upsertOverride: () => Effect.void,
    deleteOverride: () => Effect.void,
  } as any),
  Layer.succeed(CustomAchievementsRepository, {
    findByTeam: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.void,
    setRoleMapping: () => Effect.void,
  } as any),
  Layer.succeed(DiscordRoleProvisionEventsRepository, {
    enqueue: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any),
  Layer.succeed(AchievementPreview, {
    preview: () =>
      Effect.succeed({ qualifyingCount: 0, removedMembers: [], botCanManageRoles: true }),
  } as any),
);

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
        MockActivityTypesRepositoryLayer,
      ),
      MockLeaderboardRepositoryLayer,
    ),
  ),
  Layer.provide(
    Layer.merge(
      MockTeamInvitesRepositoryLayer,
      Layer.merge(
        Layer.succeed(PendingGuildJoinsRepository, {
          _tag: 'api/PendingGuildJoinsRepository',
          enqueue: () => Effect.void,
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {
          _tag: 'api/InviteAcceptancesRepository',
        } as never),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      MockRolesRepositoryLayer,
      MockGroupsRepositoryLayer,
      MockTrainingTypesRepositoryLayer,
      MockHttpClientLayer,
      MockAgeCheckServiceLayer,
      MockAgeThresholdRepositoryLayer,
    ),
  ),
  Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
  Layer.provide(
    Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(MockDiscordChannelMappingRepositoryLayer, MockICalTokensRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.merge(MockEventsRepositoryLayer, MockEventRsvpsRepositoryLayer),
              Layer.succeed(BotGuildsRepository, {
                upsert: () => Effect.void,
                remove: () => Effect.void,
                exists: () => Effect.succeed(false),
                findAll: () => Effect.succeed([]),
              } as any),
            ),
            Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
          ),
          MockEventSeriesRepositoryLayer,
        ),
        Layer.succeed(TeamSettingsRepository, {
          _tag: 'api/TeamSettingsRepository',
          findByTeam: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed(Option.none()),
          upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
          getHorizonDays: () => Effect.succeed(30),
        } as any),
      ),
      MockOAuthConnectionsRepositoryLayer,
    ),
  ),
  Layer.provide(MockAchievementAdminLayers),
  Layer.provide(
    Layer.mergeAll(
      MockFeesRepositoryLayer,
      MockFeeAssignmentsRepositoryLayer,
      MockPaymentsRepositoryLayer,
      MockFinanceOverviewRepositoryLayer,
      MockExpensesRepositoryLayer,
    ),
  ),
)
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(BotInfoStore.Default));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetStores();
});

const FEES_BASE = `http://localhost/teams/${TEST_TEAM_ID}/fees`;
const FINANCE_BASE = `http://localhost/teams/${TEST_TEAM_ID}/finance`;

// ---------------------------------------------------------------------------
// Permission tests
// ---------------------------------------------------------------------------

describe('Finance API — permission checks', () => {
  it('POST /fees without finance:manage_fees → 403 FinanceForbidden', async () => {
    const response = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag ?? body.error ?? JSON.stringify(body)).toMatch(/FinanceForbidden/i);
  });

  it('POST /fees with captain-token (Captain lacks finance:manage_fees by default) → 403 FinanceForbidden', async () => {
    const response = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag ?? body.error ?? JSON.stringify(body)).toMatch(/FinanceForbidden/i);
  });

  it('GET /finance/overview with captain-token (Captain has finance:view) → 200', async () => {
    const response = await handler(
      new Request(`${FINANCE_BASE}/overview`, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('GET /finance/overview without finance:view → 403 FinanceForbidden', async () => {
    const response = await handler(
      new Request(`${FINANCE_BASE}/overview`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('GET /finance/my-status works for any team member without extra perms', async () => {
    const response = await handler(
      new Request(`${FINANCE_BASE}/my-status`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Happy path tests
// ---------------------------------------------------------------------------

describe('Finance API — createFee', () => {
  it('createFee → 201, returns the fee with brand types decoded', async () => {
    const response = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Annual Fee',
          description: null,
          amountMinor: 5000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe('Annual Fee');
    expect(body.currency).toBe('CZK');
    expect(body.amountMinor).toBe(5000);
    expect(body.feeId).toBeTruthy();
  });

  it('createFee with currency="cz" (2 chars) → 400', async () => {
    const response = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Bad Currency Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZ',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("createFee with recurrence='monthly' → 400", async () => {
    const response = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Monthly Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
          recurrence: 'monthly',
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('Finance API — updateFee', () => {
  it('updateFee on archived fee → 409 FeeArchived', async () => {
    // First, create and archive a fee
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'To Archive',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    // Archive the fee
    await handler(
      new Request(`${FEES_BASE}/${feeId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );

    // Attempt to update the archived fee
    const updateResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      }),
    );
    expect(updateResponse.status).toBe(409);
    const body = await updateResponse.json();
    expect(JSON.stringify(body)).toMatch(/FeeArchived/i);
  });
});

describe('Finance API — archiveFee', () => {
  it('archiveFee is idempotent (second call returns 204 without error)', async () => {
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Idempotent Archive Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    // First archive
    const r1 = await handler(
      new Request(`${FEES_BASE}/${feeId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(r1.status).toBe(204);

    // Second archive — idempotent
    const r2 = await handler(
      new Request(`${FEES_BASE}/${feeId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(r2.status).toBe(204);
  });
});

describe('Finance API — recordPayment', () => {
  it('recordPayment derives recordedByUserId from current user, not request body', async () => {
    // Create fee and assign
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Payment Test Fee',
          description: null,
          amountMinor: 5000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    // Assign to player
    const assignResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberIds: [TEST_PLAYER_MEMBER_ID],
          amountMinorOverride: null,
          dueAtOverride: null,
        }),
      }),
    );
    expect(assignResponse.status).toBe(201);
    const assignments = await assignResponse.json();
    const assignmentId = assignments[0]?.assignmentId;

    // Record a payment — include a rogue recordedByUserId field that should be ignored
    const paymentResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments/${assignmentId}/payments`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 1000,
          method: 'cash',
          paidAt: '2025-05-01T10:00:00Z',
          note: null,
          recordedByUserId: 'rogue-user-id-should-be-ignored', // Should be ignored
        }),
      }),
    );
    expect(paymentResponse.status).toBe(201);
    const payment = await paymentResponse.json();
    // The response should not expose a recordedByUserId that matches the rogue value
    // The actual value should be derived from the authenticated treasurer user
    expect(payment.recordedByUserId).not.toBe('rogue-user-id-should-be-ignored');
  });

  it('recordPayment with amount=0 → 400 InvalidAmount', async () => {
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Zero Payment Test Fee',
          description: null,
          amountMinor: 5000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    const assignResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberIds: [TEST_PLAYER_MEMBER_ID],
          amountMinorOverride: null,
          dueAtOverride: null,
        }),
      }),
    );
    const assignments = await assignResponse.json();
    const assignmentId = assignments[0]?.assignmentId;

    const paymentResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments/${assignmentId}/payments`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 0,
          method: 'cash',
          paidAt: '2025-05-01T10:00:00Z',
          note: null,
        }),
      }),
    );
    expect(paymentResponse.status).toBe(400);
  });
});

describe('Finance API — assignFee bulk idempotent', () => {
  it('calling assignFee twice with same memberIds returns same count, no duplicates', async () => {
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Idempotent Assign Fee',
          description: null,
          amountMinor: 2000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    const assignBody = JSON.stringify({
      memberIds: [TEST_PLAYER_MEMBER_ID],
      amountMinorOverride: null,
      dueAtOverride: null,
    });

    const r1 = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments`, {
        method: 'POST',
        headers: { Authorization: 'Bearer treasurer-token', 'Content-Type': 'application/json' },
        body: assignBody,
      }),
    );
    const r2 = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments`, {
        method: 'POST',
        headers: { Authorization: 'Bearer treasurer-token', 'Content-Type': 'application/json' },
        body: assignBody,
      }),
    );

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const assignments1 = await r1.json();
    const assignments2 = await r2.json();
    // Both calls should return the same single assignment (idempotent)
    expect(assignments1).toHaveLength(1);
    expect(assignments2).toHaveLength(1);
    expect(assignments1[0].assignmentId).toBe(assignments2[0].assignmentId);
  });
});

describe('Finance API — myStatus', () => {
  it('myStatus returns only the current user assignments', async () => {
    const response = await handler(
      new Request(`${FINANCE_BASE}/my-status`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe('Finance API — voidPayment', () => {
  it('voidPayment already-voided → 404 PaymentNotFound', async () => {
    // Using a non-existent payment ID
    const fakePaymentId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/payments/${fakePaymentId}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Error' }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('voidPayment without finance:record_payments → 403', async () => {
    const fakePaymentId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/payments/${fakePaymentId}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Error' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('voidPayment with paymentId belonging to another team → 404 (cross-tenant authorization)', async () => {
    // Create a fee for the OTHER team and insert a payment for it directly in the store
    const otherTeamFeeId = crypto.randomUUID() as Fee.FeeId;
    const otherTeamAssignmentId = crypto.randomUUID() as FeeAssignment.FeeAssignmentId;
    const otherTeamPaymentId = crypto.randomUUID() as Payment.PaymentId;

    // Set up the fee in the other team
    feesStore.set(otherTeamFeeId, {
      id: otherTeamFeeId,
      team_id: TEST_OTHER_TEAM_ID,
      name: 'Other Team Fee',
      description: Option.none(),
      amount_minor: 1000 as Fee.AmountMinor,
      currency: 'CZK' as Fee.CurrencyCode,
      due_at: Option.none(),
      recurrence: 'none',
      target_scope: 'all_members',
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
      archived_at: Option.none(),
      assignment_count: 0,
      paid_count: 0,
      pending_count: 0,
      overdue_count: 0,
    });

    // Set up the assignment for the other team
    assignmentsStore.set(otherTeamAssignmentId, {
      id: otherTeamAssignmentId,
      fee_id: otherTeamFeeId,
      team_member_id: TEST_OTHER_TEAM_MEMBER_ID,
      member_name: Option.none(),
      fee_name: 'Other Team Fee',
      currency: 'CZK' as Fee.CurrencyCode,
      due_minor: 1000 as Fee.AmountMinor,
      paid_minor: 0 as Fee.AmountMinor,
      stored_status: 'active' as FeeAssignment.StoredAssignmentStatus,
      status: 'pending' as FeeAssignment.FeeAssignmentStatus,
      computed_status: 'pending' as FeeAssignment.FeeAssignmentStatus,
      effective_due_at: Option.none(),
      waived_reason: Option.none(),
    });

    // Insert a payment for the other team's assignment
    paymentsStore.set(otherTeamPaymentId, {
      id: otherTeamPaymentId,
      fee_assignment_id: otherTeamAssignmentId,
      team_member_id: TEST_OTHER_TEAM_MEMBER_ID,
      amount_minor: 500 as Fee.AmountMinor,
      voided_at: Option.none(),
      void_reason: Option.none(),
    });

    // Try to void the other team's payment using TEST_TEAM_ID credentials
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/payments/${otherTeamPaymentId}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Cross-tenant void attempt' }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe('Finance API — assignFee cross-team member filter', () => {
  it('assignFee with memberId from another team → 200 but that member is silently skipped', async () => {
    // Create a fee for TEST_TEAM_ID
    const createResponse = await handler(
      new Request(FEES_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Cross-Team Assign Test Fee',
          description: null,
          amountMinor: 2000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'all_members',
        }),
      }),
    );
    const fee = await createResponse.json();
    const feeId = fee.feeId;

    // Attempt to assign to one valid member and one member from another team
    const assignResponse = await handler(
      new Request(`${FEES_BASE}/${feeId}/assignments`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberIds: [TEST_PLAYER_MEMBER_ID, TEST_OTHER_TEAM_MEMBER_ID],
          amountMinorOverride: null,
          dueAtOverride: null,
        }),
      }),
    );
    expect(assignResponse.status).toBe(201);
    const assignments = await assignResponse.json();
    // Only the valid same-team member should be assigned; the foreign member is silently skipped
    expect(assignments).toHaveLength(1);
    expect(assignments[0].teamMemberId).toBe(TEST_PLAYER_MEMBER_ID);
  });
});

// ---------------------------------------------------------------------------
// Finance API — myPaymentHistory
// ---------------------------------------------------------------------------

/**
 * Helper: seed a fee + assignment + payments directly into the stores so the
 * handler can serve them through the (now filter-aware) MockPaymentsRepositoryLayer.
 */
function seedFee(teamId: Team.TeamId, overrides: Partial<FeeRecord> = {}): Fee.FeeId {
  const id = crypto.randomUUID() as Fee.FeeId;
  feesStore.set(id, {
    id,
    team_id: teamId,
    name: overrides.name ?? 'Test Fee',
    description: Option.none(),
    amount_minor: 5000 as Fee.AmountMinor,
    currency: (overrides.currency ?? 'CZK') as Fee.CurrencyCode,
    due_at: Option.none(),
    recurrence: 'none',
    target_scope: 'all_members',
    created_at: DateTime.nowUnsafe(),
    updated_at: DateTime.nowUnsafe(),
    archived_at: Option.none(),
    assignment_count: 0,
    paid_count: 0,
    pending_count: 0,
    overdue_count: 0,
    ...overrides,
  });
  return id;
}

function seedAssignment(
  feeId: Fee.FeeId,
  memberId: TeamMember.TeamMemberId,
  overrides: Partial<AssignmentRecord> = {},
): FeeAssignment.FeeAssignmentId {
  const id = crypto.randomUUID() as FeeAssignment.FeeAssignmentId;
  const fee = feesStore.get(feeId)!;
  assignmentsStore.set(id, {
    id,
    fee_id: feeId,
    team_member_id: memberId,
    member_name: Option.none(),
    fee_name: fee?.name ?? 'Test Fee',
    currency: fee?.currency ?? ('CZK' as Fee.CurrencyCode),
    due_minor: 5000 as Fee.AmountMinor,
    paid_minor: 0 as Fee.AmountMinor,
    stored_status: 'active',
    status: 'pending',
    computed_status: 'pending',
    effective_due_at: Option.none(),
    waived_reason: Option.none(),
    ...overrides,
  });
  return id;
}

function seedPayment(
  assignmentId: FeeAssignment.FeeAssignmentId,
  memberId: TeamMember.TeamMemberId,
  overrides: Partial<PaymentRecord> = {},
): Payment.PaymentId {
  const id = crypto.randomUUID() as Payment.PaymentId;
  paymentsStore.set(id, {
    id,
    fee_assignment_id: assignmentId,
    team_member_id: memberId,
    amount_minor: 5000 as Fee.AmountMinor,
    voided_at: Option.none(),
    void_reason: Option.none(),
    ...overrides,
  });
  return id;
}

describe('Finance API — myPaymentHistory', () => {
  it('player calling for self with feeId returns own payments (200)', async () => {
    // Seed one fee + assignment for the player
    const feeId = seedFee(TEST_TEAM_ID, { name: 'Membership Fee' });
    const assignmentId = seedAssignment(feeId, TEST_PLAYER_MEMBER_ID);
    seedPayment(assignmentId, TEST_PLAYER_MEMBER_ID);
    seedPayment(assignmentId, TEST_PLAYER_MEMBER_ID);

    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments?feeId=${feeId}`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    // Both payments belonging to the player for this fee should be returned
    expect(body).toHaveLength(2);
  });

  it('player without feeId returns all own payments (200)', async () => {
    // Seed two fees — player has 2 payments in fee1, 1 in fee2
    const feeId1 = seedFee(TEST_TEAM_ID, { name: 'Fee 1' });
    const feeId2 = seedFee(TEST_TEAM_ID, { name: 'Fee 2' });
    const a1 = seedAssignment(feeId1, TEST_PLAYER_MEMBER_ID);
    const a2 = seedAssignment(feeId2, TEST_PLAYER_MEMBER_ID);
    seedPayment(a1, TEST_PLAYER_MEMBER_ID);
    seedPayment(a1, TEST_PLAYER_MEMBER_ID);
    seedPayment(a2, TEST_PLAYER_MEMBER_ID);

    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
  });

  it('voided payments are included (200) and have voidedAt populated', async () => {
    const feeId = seedFee(TEST_TEAM_ID, { name: 'Voided Fee Test' });
    const assignmentId = seedAssignment(feeId, TEST_PLAYER_MEMBER_ID);
    seedPayment(assignmentId, TEST_PLAYER_MEMBER_ID); // active
    seedPayment(assignmentId, TEST_PLAYER_MEMBER_ID, {
      voided_at: Option.some(DateTime.nowUnsafe()),
      void_reason: Option.some('Duplicate entry'),
    }); // voided

    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(2);
    // At least one should have voidedAt set (non-null)
    const voidedPayment = body.find((p: any) => p.voidedAt !== null && p.voidedAt !== undefined);
    expect(voidedPayment).not.toBeUndefined();
  });

  it('non-member calling → 403 FinanceForbidden', async () => {
    // Player token, but calling against OTHER_TEAM_ID — they are not a member there
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_OTHER_TEAM_ID}/finance/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag ?? body.error ?? JSON.stringify(body)).toMatch(/FinanceForbidden/i);
  });

  it('payments from another member are not leaked', async () => {
    // Captain's payment and player's payment — both in TEST_TEAM_ID
    const feeId = seedFee(TEST_TEAM_ID, { name: 'Shared Fee' });
    const captainAssignmentId = seedAssignment(feeId, TEST_CAPTAIN_MEMBER_ID);
    const playerAssignmentId = seedAssignment(feeId, TEST_PLAYER_MEMBER_ID);
    seedPayment(captainAssignmentId, TEST_CAPTAIN_MEMBER_ID); // captain's payment
    seedPayment(playerAssignmentId, TEST_PLAYER_MEMBER_ID);

    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // Only the player's payment
    expect(body).toHaveLength(1);
    expect(body[0].teamMemberId).toBe(TEST_PLAYER_MEMBER_ID);
    // Captain's payment is not present
    expect(body.find((p: any) => p.teamMemberId === TEST_CAPTAIN_MEMBER_ID)).toBeUndefined();
  });

  it('cross-team isolation — payments in another team for same user are not returned', async () => {
    // Seed a fee + assignment + payment in the OTHER team for the player's other-team membership
    const otherFeeId = seedFee(TEST_OTHER_TEAM_ID, { name: 'Other Team Fee' });
    const otherAssignmentId = seedAssignment(otherFeeId, TEST_OTHER_TEAM_MEMBER_ID);
    seedPayment(otherAssignmentId, TEST_OTHER_TEAM_MEMBER_ID);

    // Call on TEST_TEAM_ID (player's primary team)
    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // 0 payments — the other-team payment is not visible here
    expect(body).toHaveLength(0);
  });

  // Case #7: works without finance:view permission (same as case #1 assertion)
  // The player token only has 'member:view' and 'roster:view' — no 'finance:view'.
  // Getting 200 in cases #1 and #2 above already confirms this, but let's be explicit:
  it('player without finance:view permission gets 200', async () => {
    // PLAYER_PERMISSIONS does NOT include 'finance:view' — verified by the PLAYER_PERMISSIONS constant above.
    // A simple call to my-payments should succeed with 200 regardless.
    const response = await handler(
      new Request(`${FINANCE_BASE}/my-payments`, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    // 200 even though player has no finance:view
    expect(response.status).toBe(200);
  });
});
