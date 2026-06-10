import type { Auth, EmailForwarding, Role, Team, TeamMember } from '@sideline/domain';
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
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
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
import { EmailApprovalService } from '~/services/EmailApprovalService.js';
import { EmailSecretCrypto } from '~/services/EmailSecretCrypto.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const COACH_USER_ID = '00000000-0000-0000-0001-000000000001' as Auth.UserId;
const MEMBER_USER_ID = '00000000-0000-0000-0001-000000000002' as Auth.UserId;
const OUTSIDER_USER_ID = '00000000-0000-0000-0001-000000000003' as Auth.UserId;
const TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0001-000000000020' as Team.TeamId;
const COACH_MEMBER_ID = '00000000-0000-0000-0001-000000000011' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_ID = '00000000-0000-0000-0001-000000000012' as TeamMember.TeamMemberId;

const EMAIL_ID_PENDING = '11111111-1111-1111-1111-111111111111' as EmailForwarding.EmailMessageId;
const EMAIL_ID_RECEIVED = '22222222-2222-2222-2222-222222222222' as EmailForwarding.EmailMessageId;
const EMAIL_ID_OTHER_TEAM =
  '33333333-3333-3333-3333-333333333333' as EmailForwarding.EmailMessageId;
const ATTACHMENT_ID = '44444444-4444-4444-4444-444444444444' as EmailForwarding.EmailAttachmentId;
const BOGUS_EMAIL_ID = '99999999-9999-9999-9999-999999999999' as EmailForwarding.EmailMessageId;
const BOGUS_ATTACHMENT_ID =
  '99999999-9999-9999-9999-000000000001' as EmailForwarding.EmailAttachmentId;

const COACH_PERMISSIONS: readonly Role.Permission[] = ['team:manage'];
const MEMBER_PERMISSIONS: readonly Role.Permission[] = ['roster:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const now = DateTime.makeUnsafe('2024-01-01T00:00:00Z');

type EmailRecord = {
  id: EmailForwarding.EmailMessageId;
  team_id: string;
  status: EmailForwarding.EmailStatus;
  from_address: string;
  subject: string;
  body: string;
  summary: Option.Option<string>;
  short_summary: Option.Option<string>;
  summarize_attempts: number;
  last_error: Option.Option<string>;
  approval_request_message_id: Option.Option<string>;
  approved_by: Option.Option<string>;
  rejected_by: Option.Option<string>;
  posted_channel_id: Option.Option<string>;
  received_at: DateTime.Utc;
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

let emailStore: Map<EmailForwarding.EmailMessageId, EmailRecord>;
let summaryUpdateCalls: Array<{ id: EmailForwarding.EmailMessageId; summary: string }>;
let enqueuedSyncEvents: Array<{ emailId: EmailForwarding.EmailMessageId; kind: string }>;

const makeEmailRecord = (
  id: EmailForwarding.EmailMessageId,
  overrides: Partial<EmailRecord> = {},
): EmailRecord => ({
  id,
  team_id: TEAM_ID,
  status: 'pending_approval',
  from_address: 'sender@example.com',
  subject: 'Team Update',
  body: 'Email body text',
  summary: Option.some('AI-generated summary'),
  short_summary: Option.none(),
  summarize_attempts: 1,
  last_error: Option.none(),
  approval_request_message_id: Option.none(),
  approved_by: Option.none(),
  rejected_by: Option.none(),
  posted_channel_id: Option.none(),
  received_at: now,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const ATTACHMENT_CONTENT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

const resetStores = () => {
  emailStore = new Map();
  summaryUpdateCalls = [];
  enqueuedSyncEvents = [];

  emailStore.set(
    EMAIL_ID_PENDING,
    makeEmailRecord(EMAIL_ID_PENDING, { status: 'pending_approval' }),
  );
  emailStore.set(
    EMAIL_ID_RECEIVED,
    makeEmailRecord(EMAIL_ID_RECEIVED, { status: 'received', summary: Option.none() }),
  );
  emailStore.set(
    EMAIL_ID_OTHER_TEAM,
    makeEmailRecord(EMAIL_ID_OTHER_TEAM, { team_id: OTHER_TEAM_ID }),
  );
};

// ---------------------------------------------------------------------------
// Auth stores
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['coach-token', COACH_USER_ID],
  ['member-token', MEMBER_USER_ID],
  ['outsider-token', OUTSIDER_USER_ID],
]);

const usersMap = new Map<Auth.UserId, any>([
  [
    COACH_USER_ID,
    {
      id: COACH_USER_ID,
      discord_id: '111111111111111111',
      username: 'coach',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      discord_nickname: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    MEMBER_USER_ID,
    {
      id: MEMBER_USER_ID,
      discord_id: '222222222222222222',
      username: 'member',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      discord_nickname: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    OUTSIDER_USER_ID,
    {
      id: OUTSIDER_USER_ID,
      discord_id: '333333333333333333',
      username: 'outsider',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      discord_nickname: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
]);

const membersStore = new Map<string, MembershipWithRole>([
  [
    `${TEAM_ID}:${COACH_USER_ID}`,
    {
      id: COACH_MEMBER_ID,
      team_id: TEAM_ID,
      user_id: COACH_USER_ID,
      active: true,
      role_names: ['Coach'],
      permissions: COACH_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
  [
    `${TEAM_ID}:${MEMBER_USER_ID}`,
    {
      id: MEMBER_MEMBER_ID,
      team_id: TEAM_ID,
      user_id: MEMBER_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: MEMBER_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
]);

// ---------------------------------------------------------------------------
// noop builder
// ---------------------------------------------------------------------------

const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: () =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(new OAuth2Tokens({ access_token: 'mock', refresh_token: 'mock' })),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) =>
    Effect.succeed(usersMap.has(id) ? Option.some(usersMap.get(id)!) : Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.void,
  updateAdminProfile: () => Effect.void,
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({ id: 'session-1', user_id: userId, token, expires_at: now, created_at: now }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: (id: Team.TeamId) =>
    Effect.succeed(
      id === TEAM_ID
        ? Option.some({
            id: TEAM_ID,
            name: 'Test Team',
            guild_id: '888888888888888888',
            created_by: COACH_USER_ID,
            created_at: now,
            updated_at: now,
          })
        : Option.none(),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = membersStore.get(`${teamId}:${userId}`);
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findTeamMembersWithNames: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  findMembershipByDiscordAndTeam: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  reactivateMember: () => Effect.void,
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
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Email-specific mocks with real in-memory behavior
// ---------------------------------------------------------------------------

const MockEmailMessagesRepositoryLayer = Layer.succeed(EmailMessagesRepository, {
  _tag: 'api/EmailMessagesRepository' as const,
  insertReceived: () => Effect.die(new Error('not implemented')),
  findById: (id: EmailForwarding.EmailMessageId) => {
    const row = emailStore.get(id);
    return Effect.succeed(row ? Option.some(row) : Option.none());
  },
  findReceivedBatch: () => Effect.succeed([]),
  claimForSummarizing: () => Effect.succeed(Option.none()),
  setSummaryPendingApproval: () => Effect.void,
  updateSummary: (id: EmailForwarding.EmailMessageId, summary: string, _shortSummary?: string) => {
    summaryUpdateCalls.push({ id, summary });
    const row = emailStore.get(id);
    if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
    emailStore.set(id, { ...row, summary: Option.some(summary) });
    return Effect.succeed(Option.some(id));
  },
  incrementAttemptsAndMaybeFail: () => Effect.void,
  approve: (id: EmailForwarding.EmailMessageId, by: string) => {
    const row = emailStore.get(id);
    if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
    emailStore.set(id, { ...row, status: 'approved', approved_by: Option.some(by) });
    return Effect.succeed(Option.some(id));
  },
  sendOriginal: (id: EmailForwarding.EmailMessageId, by: string) => {
    const row = emailStore.get(id);
    if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
    emailStore.set(id, { ...row, status: 'send_original', approved_by: Option.some(by) });
    return Effect.succeed(Option.some(id));
  },
  dismiss: (id: EmailForwarding.EmailMessageId, by: string) => {
    const row = emailStore.get(id);
    if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
    emailStore.set(id, { ...row, status: 'rejected', rejected_by: Option.some(by) });
    return Effect.succeed(Option.some(id));
  },
  setPosted: () => Effect.void,
} as never);

// Build EmailAttachmentMeta inline to avoid dynamic require
const makeAttachmentMeta = (): EmailForwarding.EmailAttachmentMeta => {
  // Use a plain object matching the schema shape
  return {
    attachmentId: ATTACHMENT_ID,
    filename: 'report.png',
    contentType: 'image/png',
    sizeBytes: ATTACHMENT_CONTENT.length,
    createdAt: now,
  } as unknown as EmailForwarding.EmailAttachmentMeta;
};

const MockEmailAttachmentsRepositoryLayer = Layer.succeed(EmailAttachmentsRepository, {
  _tag: 'api/EmailAttachmentsRepository' as const,
  insertMany: () => Effect.void,
  listMetaByEmail: (_emailId: EmailForwarding.EmailMessageId) =>
    Effect.succeed([makeAttachmentMeta()]),
  findByIdWithBytes: (
    attachmentId: EmailForwarding.EmailAttachmentId,
    _emailId: EmailForwarding.EmailMessageId,
  ) => {
    if (attachmentId === ATTACHMENT_ID) {
      return Effect.succeed(
        Option.some({
          filename: 'report.png',
          contentType: 'image/png',
          sizeBytes: ATTACHMENT_CONTENT.length,
          content: ATTACHMENT_CONTENT,
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
} as never);

const MockEmailForwardingConfigRepositoryLayer = Layer.succeed(EmailForwardingConfigRepository, {
  _tag: 'api/EmailForwardingConfigRepository' as const,
  findByTeam: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('not implemented')),
  findByInboundToken: () => Effect.succeed(Option.none()),
  regenerateToken: () => Effect.die(new Error('not implemented')),
} as never);

const MockEmailPostSyncEventsRepositoryLayer = Layer.succeed(EmailPostSyncEventsRepository, {
  _tag: 'api/EmailPostSyncEventsRepository' as const,
  enqueue: (emailId: EmailForwarding.EmailMessageId, _teamId: string, kind: string) => {
    enqueuedSyncEvents.push({ emailId, kind });
    return Effect.void;
  },
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

const MockEmailApprovalServiceLayer = EmailApprovalService.Default.pipe(
  Layer.provide(MockEmailMessagesRepositoryLayer),
  Layer.provide(MockEmailPostSyncEventsRepositoryLayer),
);

// ---------------------------------------------------------------------------
// Build full test layer following the Mock-Layer Cascade pattern
// ---------------------------------------------------------------------------

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  // Email repos (live behavior for these tests)
  Layer.provide(MockEmailMessagesRepositoryLayer),
  Layer.provide(MockEmailAttachmentsRepositoryLayer),
  Layer.provide(MockEmailForwardingConfigRepositoryLayer),
  Layer.provide(MockEmailPostSyncEventsRepositoryLayer),
  Layer.provide(Layer.merge(MockEmailApprovalServiceLayer, EmailSecretCrypto.Default)),
  // Remaining repos
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ActivityLogsRepository,
        buildNoop('api/ActivityLogsRepository', { findByTeamMember: () => Effect.succeed([]) }),
      ),
      Layer.succeed(
        ActivityTypesRepository,
        buildNoop('api/ActivityTypesRepository', {
          findBySlug: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findByIdScoped: () => Effect.succeed(Option.none()),
          findByNameInScope: () => Effect.succeed(Option.none()),
          countLogsForType: () => Effect.succeed(0),
        }),
      ),
      Layer.succeed(
        LeaderboardRepository,
        buildNoop('api/LeaderboardRepository', { getLeaderboard: () => Effect.succeed([]) }),
      ),
      Layer.succeed(
        RostersRepository,
        buildNoop('api/RostersRepository', {
          findByTeamId: () => Effect.succeed([]),
          findRosterById: () => Effect.succeed(Option.none()),
          findMemberEntriesById: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        TeamInvitesRepository,
        buildNoop('api/TeamInvitesRepository', {
          findByCode: () => Effect.succeed(Option.none()),
          findByTeam: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        PendingGuildJoinsRepository,
        buildNoop('api/PendingGuildJoinsRepository', { listPending: () => Effect.succeed([]) }),
      ),
      Layer.succeed(InviteAcceptancesRepository, buildNoop('api/InviteAcceptancesRepository')),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        RolesRepository,
        buildNoop('api/RolesRepository', {
          findRolesByTeamId: () => Effect.succeed([]),
          findRoleById: () => Effect.succeed(Option.none()),
          getPermissionsForRoleId: () => Effect.succeed([]),
          findRoleByTeamAndName: () => Effect.succeed(Option.none()),
          seedTeamRolesWithPermissions: () => Effect.succeed([]),
          getMemberCountForRole: () => Effect.succeed(0),
          findGroupsForRole: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        GroupsRepository,
        buildNoop('api/GroupsRepository', {
          findGroupsByTeamId: () => Effect.succeed([]),
          findGroupById: () => Effect.succeed(Option.none()),
          findMembersByGroupId: () => Effect.succeed([]),
          getMemberCount: () => Effect.succeed(0),
          getChildren: () => Effect.succeed([]),
          getAncestorIds: () => Effect.succeed([]),
          getDescendantMemberIds: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        TrainingTypesRepository,
        buildNoop('api/TrainingTypesRepository', {
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findByIdWithGroup: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        AgeCheckService,
        buildNoop('AgeCheckService', {
          evaluateTeam: () => Effect.succeed([]),
          evaluate: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        AgeThresholdRepository,
        buildNoop('api/AgeThresholdRepository', {
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findAllTeamsWithRules: () => Effect.succeed([]),
          findMembersWithBirthYears: () => Effect.succeed([]),
          findRulesByTeamId: () => Effect.succeed([]),
          findRuleById: () => Effect.succeed(Option.none()),
          getAllTeamsWithRules: () => Effect.succeed([]),
          getMembersForAutoAssignment: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        NotificationsRepository,
        buildNoop('api/NotificationsRepository', {
          findByUserId: () => Effect.succeed([]),
          findOneById: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        RoleSyncEventsRepository,
        buildNoop('api/RoleSyncEventsRepository', { findUnprocessed: () => Effect.succeed([]) }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ChannelSyncEventsRepository,
        buildNoop('api/ChannelSyncEventsRepository', {
          findUnprocessed: () => Effect.succeed([]),
          hasUnprocessedForGroups: () => Effect.succeed([]),
          hasUnprocessedForRosters: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        EventSyncEventsRepository,
        buildNoop('api/EventSyncEventsRepository', { findUnprocessed: () => Effect.succeed([]) }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        DiscordChannelMappingRepository,
        buildNoop('api/DiscordChannelMappingRepository', {
          findByGroupId: () => Effect.succeed(Option.none()),
          findAllByTeamId: () => Effect.succeed([]),
          findAllByTeam: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        ICalTokensRepository,
        buildNoop('api/ICalTokensRepository', {
          findByToken: () => Effect.succeed(Option.none()),
          findByUserId: () => Effect.succeed(Option.none()),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        EventsRepository,
        buildNoop('api/EventsRepository', {
          findByTeamId: () => Effect.succeed([]),
          findEventsByTeamId: () => Effect.succeed([]),
          findByIdWithDetails: () => Effect.succeed(Option.none()),
          findEventByIdWithDetails: () => Effect.succeed(Option.none()),
          findScopedTrainingTypeIds: () => Effect.succeed([]),
          getScopedTrainingTypeIds: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        EventRsvpsRepository,
        buildNoop('api/EventRsvpsRepository', {
          findByEventId: () => Effect.succeed([]),
          findRsvpsByEventId: () => Effect.succeed([]),
          findByEventAndMember: () => Effect.succeed(Option.none()),
          findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
          countByEventId: () => Effect.succeed([]),
          countRsvpsByEventId: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        BotGuildsRepository,
        buildNoop('api/BotGuildsRepository', {
          exists: () => Effect.succeed(false),
          findAll: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        DiscordChannelsRepository,
        buildNoop('api/DiscordChannelsRepository', { findByGuildId: () => Effect.succeed([]) }),
      ),
      Layer.succeed(DiscordRolesRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      Layer.succeed(
        EventSeriesRepository,
        buildNoop('api/EventSeriesRepository', {
          findByTeamId: () => Effect.succeed([]),
          findSeriesByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findSeriesById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        TeamSettingsRepository,
        buildNoop('api/TeamSettingsRepository', {
          findByTeam: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed(Option.none()),
          getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
          getHorizonDays: () => Effect.succeed(30),
        }),
      ),
      Layer.succeed(
        OAuthConnectionsRepository,
        buildNoop('api/OAuthConnectionsRepository', {
          findByUserAndProvider: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed(Option.none()),
          findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock' })),
          getAccessToken: () => Effect.succeed('mock'),
        }),
      ),
    ),
  ),
)
  .pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AchievementRoleMappingsRepository,
          buildNoop('api/AchievementRoleMappingsRepository', {
            findAllByTeam: () => Effect.succeed([]),
          }),
        ),
        Layer.succeed(
          AchievementSettingsRepository,
          buildNoop('api/AchievementSettingsRepository', {
            findOverridesByTeam: () => Effect.succeed(new Map()),
          }),
        ),
        Layer.succeed(
          CustomAchievementsRepository,
          buildNoop('api/CustomAchievementsRepository', {
            findByTeam: () => Effect.succeed([]),
            findById: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.succeed(
          DiscordRoleProvisionEventsRepository,
          buildNoop('api/DiscordRoleProvisionEventsRepository', {
            findUnprocessed: () => Effect.succeed([]),
          }),
        ),
        Layer.succeed(
          AchievementPreview,
          buildNoop('AchievementPreview', {
            preview: () =>
              Effect.succeed({ qualifyingCount: 0, removedMembers: [], botCanManageRoles: true }),
          }),
        ),
      ),
    ),
  )
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default));

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const emailUrl = (teamId: string, emailId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}`;

const summaryUrl = (teamId: string, emailId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}/summary`;

const approveUrl = (teamId: string, emailId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}/approve`;

const sendOriginalUrl = (teamId: string, emailId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}/send-original`;

const rejectUrl = (teamId: string, emailId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}/reject`;

const attachmentUrl = (teamId: string, emailId: string, attachmentId: string) =>
  `http://localhost/teams/${teamId}/emails/${emailId}/attachments/${attachmentId}`;

// ---------------------------------------------------------------------------
// getEmail
// ---------------------------------------------------------------------------

describe('getEmail — GET /teams/:teamId/emails/:emailId', () => {
  it('coach member gets 200 with email detail and attachment meta (no bytes)', async () => {
    const response = await handler(
      new Request(emailUrl(TEAM_ID, EMAIL_ID_PENDING), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.emailId).toBe(EMAIL_ID_PENDING);
    expect(body.subject).toBe('Team Update');
    // Attachments should include meta but no bytes
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments.length).toBeGreaterThan(0);
    // Should not have a 'content' or 'bytes' field
    const att = body.attachments[0];
    expect(att).not.toHaveProperty('content');
    expect(att.attachmentId).toBe(ATTACHMENT_ID);
  });

  it('non-manager member gets 200 (read access)', async () => {
    const response = await handler(
      new Request(emailUrl(TEAM_ID, EMAIL_ID_PENDING), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('non-member gets 403', async () => {
    const response = await handler(
      new Request(emailUrl(TEAM_ID, EMAIL_ID_PENDING), {
        headers: { Authorization: 'Bearer outsider-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('unknown emailId returns 404', async () => {
    const response = await handler(
      new Request(emailUrl(TEAM_ID, BOGUS_EMAIL_ID), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('email from another team returns 404 (not 403 — no info leak)', async () => {
    const response = await handler(
      new Request(emailUrl(TEAM_ID, EMAIL_ID_OTHER_TEAM), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('unauthenticated request returns 401', async () => {
    const response = await handler(new Request(emailUrl(TEAM_ID, EMAIL_ID_PENDING)));
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// updateEmailSummary — PUT /teams/:teamId/emails/:emailId/summary
// ---------------------------------------------------------------------------

describe('updateEmailSummary — PUT /teams/:teamId/emails/:emailId/summary', () => {
  it('coach updates summary on pending email → 200 with updated EmailDetailView', async () => {
    const response = await handler(
      new Request(summaryUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer coach-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ summary: 'Coach-edited summary text', short_summary: 'Short edit' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toBe('Coach-edited summary text');
    // Should have persisted the update
    expect(summaryUpdateCalls.some((c) => c.id === EMAIL_ID_PENDING)).toBe(true);
  });

  it('non-coach member gets 403', async () => {
    const response = await handler(
      new Request(summaryUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ summary: 'Should not be saved', short_summary: 'Short' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(summaryUpdateCalls).toHaveLength(0);
  });

  it('update on non-pending email returns 404 (updateSummary returns None)', async () => {
    // EMAIL_ID_RECEIVED has status 'received', not 'pending_approval'
    const response = await handler(
      new Request(summaryUrl(TEAM_ID, EMAIL_ID_RECEIVED), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer coach-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ summary: 'Should not work', short_summary: 'Short' }),
      }),
    );
    // updateSummary returns None → 404 in the handler
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// approveEmail — POST /teams/:teamId/emails/:emailId/approve
// ---------------------------------------------------------------------------

describe('approveEmail — POST /teams/:teamId/emails/:emailId/approve', () => {
  it('coach approves pending email → 200 with outcome=approved, enqueues post_summary', async () => {
    const response = await handler(
      new Request(approveUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('approved');
    expect(emailStore.get(EMAIL_ID_PENDING)?.status).toBe('approved');
    expect(enqueuedSyncEvents.some((e) => e.kind === 'post_summary')).toBe(true);
  });

  it('non-coach gets 403', async () => {
    const response = await handler(
      new Request(approveUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(403);
    expect(emailStore.get(EMAIL_ID_PENDING)?.status).toBe('pending_approval');
  });

  it('unknown emailId returns 404', async () => {
    const response = await handler(
      new Request(approveUrl(TEAM_ID, BOGUS_EMAIL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('already-handled email returns 200 with outcome=already_handled (idempotent)', async () => {
    // First approval
    await handler(
      new Request(approveUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    // Second approval
    const response = await handler(
      new Request(approveUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('already_handled');
    // Only one post_summary event
    expect(enqueuedSyncEvents.filter((e) => e.kind === 'post_summary')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sendOriginalEmail — POST /teams/:teamId/emails/:emailId/send-original
// ---------------------------------------------------------------------------

describe('sendOriginalEmail — POST /teams/:teamId/emails/:emailId/send-original', () => {
  it('coach sends original on pending email → 200 with outcome=sent_original, enqueues post_original', async () => {
    const response = await handler(
      new Request(sendOriginalUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('sent_original');
    expect(emailStore.get(EMAIL_ID_PENDING)?.status).toBe('send_original');
    expect(enqueuedSyncEvents.some((e) => e.kind === 'post_original')).toBe(true);
  });

  it('non-coach gets 403', async () => {
    const response = await handler(
      new Request(sendOriginalUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(403);
    expect(emailStore.get(EMAIL_ID_PENDING)?.status).toBe('pending_approval');
  });

  it('unknown emailId returns 404', async () => {
    const response = await handler(
      new Request(sendOriginalUrl(TEAM_ID, BOGUS_EMAIL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('already-handled email returns 200 with outcome=already_handled (idempotent)', async () => {
    // First call
    await handler(
      new Request(sendOriginalUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    // Second call
    const response = await handler(
      new Request(sendOriginalUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('already_handled');
    // Only one post_original event
    expect(enqueuedSyncEvents.filter((e) => e.kind === 'post_original')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rejectEmail — POST /teams/:teamId/emails/:emailId/reject
// ---------------------------------------------------------------------------

describe('rejectEmail — POST /teams/:teamId/emails/:emailId/reject', () => {
  it('coach dismisses pending email → 200 with outcome=dismissed, NO sync event enqueued', async () => {
    const response = await handler(
      new Request(rejectUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('dismissed');
    expect(emailStore.get(EMAIL_ID_PENDING)?.status).toBe('rejected');
    // dismiss does NOT enqueue any sync event
    expect(enqueuedSyncEvents).toHaveLength(0);
  });

  it('non-coach gets 403', async () => {
    const response = await handler(
      new Request(rejectUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('unknown emailId returns 404 EmailMessageNotFound', async () => {
    const response = await handler(
      new Request(rejectUrl(TEAM_ID, BOGUS_EMAIL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('already-handled email returns 200 with outcome=already_handled (idempotent)', async () => {
    // First call
    await handler(
      new Request(rejectUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    // Second call
    const response = await handler(
      new Request(rejectUrl(TEAM_ID, EMAIL_ID_PENDING), {
        method: 'POST',
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('already_handled');
    expect(enqueuedSyncEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// downloadEmailAttachment — GET /teams/:teamId/emails/:emailId/attachments/:attachmentId
// ---------------------------------------------------------------------------

describe('downloadEmailAttachment — GET /teams/.../attachments/:attachmentId', () => {
  it('member gets 200 with correct content-type and content-disposition', async () => {
    const response = await handler(
      new Request(attachmentUrl(TEAM_ID, EMAIL_ID_PENDING, ATTACHMENT_ID), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('report.png');
    // Verify content round-trips correctly
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(ATTACHMENT_CONTENT);
  });

  it('non-member gets 403', async () => {
    const response = await handler(
      new Request(attachmentUrl(TEAM_ID, EMAIL_ID_PENDING, ATTACHMENT_ID), {
        headers: { Authorization: 'Bearer outsider-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('attachmentId not belonging to emailId returns 404', async () => {
    const response = await handler(
      new Request(attachmentUrl(TEAM_ID, EMAIL_ID_PENDING, BOGUS_ATTACHMENT_ID), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('filename in content-disposition has no CR/LF injection', async () => {
    const response = await handler(
      new Request(attachmentUrl(TEAM_ID, EMAIL_ID_PENDING, ATTACHMENT_ID), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).not.toMatch(/[\r\n]/);
  });
});
