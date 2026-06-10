/**
 * API tests for the IMAP-specific parts of the email-forwarding endpoints.
 *
 * Covers:
 * 1. PUT with imap_* fields + imap_secret → repo receives encrypted secret (not plaintext);
 *    response EmailForwardingConfigView has imapSecretSet=true; JSON contains no secret value.
 * 2. GET (findByTeam returns row with imap_secret_encrypted=Some('enc')) → imapSecretSet=true, no secret in JSON.
 * 3. PUT WITHOUT imap_secret (key absent) → repo receives imap_secret_encrypted=None (preserve path).
 */
import type { Auth, Role, Team, TeamMember } from '@sideline/domain';
import { Discord } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
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
import {
  EmailForwardingConfigRepository,
  type EmailForwardingConfigRow,
} from '~/repositories/EmailForwardingConfigRepository.js';
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
import { EmailSecretCrypto, makeWithKey } from '~/services/EmailSecretCrypto.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

const COACH_USER_ID = '00000000-0000-0001-0001-000000000001' as Auth.UserId;
const TEAM_ID = '00000000-0000-0001-0001-000000000010' as Team.TeamId;
const COACH_MEMBER_ID = '00000000-0000-0001-0001-000000000011' as TeamMember.TeamMemberId;
const COACH_PERMISSIONS: readonly Role.Permission[] = ['team:manage'];

const now = DateTime.makeUnsafe('2024-01-01T00:00:00Z');

// ---------------------------------------------------------------------------
// Stores for recording repo calls
// ---------------------------------------------------------------------------

// Explicit type (mirrors the contracted upsert signature, so tests are compile-independent of build)
interface UpsertCall {
  readonly team_id: string;
  readonly enabled: boolean;
  readonly target_channel_id: string;
  readonly coach_channel_id: string;
  readonly monitored_addresses: readonly string[];
  readonly imap_enabled: boolean;
  readonly imap_host: Option.Option<string>;
  readonly imap_port: Option.Option<number>;
  readonly imap_username: Option.Option<string>;
  readonly imap_secret_encrypted: Option.Option<string>;
  readonly imap_use_tls: boolean;
  readonly imap_folder: Option.Option<string>;
}

let upsertCalls: UpsertCall[];
let configRowOverride: Option.Option<EmailForwardingConfigRow>;

const resetStores = () => {
  upsertCalls = [];
  configRowOverride = Option.none();
};

// ---------------------------------------------------------------------------
// Shared mock builder
// ---------------------------------------------------------------------------

const makeConfig = (overrides: Partial<EmailForwardingConfigRow> = {}): EmailForwardingConfigRow =>
  ({
    team_id: TEAM_ID as unknown as EmailForwardingConfigRow['team_id'],
    enabled: true,
    target_channel_id: Schema.decodeSync(Discord.Snowflake)('111111111111111111'),
    coach_channel_id: Schema.decodeSync(Discord.Snowflake)('222222222222222222'),
    monitored_addresses: [] as unknown as EmailForwardingConfigRow['monitored_addresses'],
    inbound_token: 'tok',
    imap_enabled: false,
    imap_host: Option.none(),
    imap_port: Option.none(),
    imap_username: Option.none(),
    imap_secret_encrypted: Option.none(),
    imap_use_tls: true,
    imap_folder: Option.none(),
    imap_last_seen_uid: 0,
    imap_uid_validity: Option.none(),
    imap_last_synced_at: Option.none(),
    created_at: now,
    updated_at: now,
    ...overrides,
  }) as unknown as EmailForwardingConfigRow;

// ---------------------------------------------------------------------------
// noop builder (mirrors existing test helpers)
// ---------------------------------------------------------------------------

const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

// ---------------------------------------------------------------------------
// Config repo mock with recording
// ---------------------------------------------------------------------------

const MockEmailForwardingConfigRepositoryLayer = Layer.succeed(EmailForwardingConfigRepository, {
  _tag: 'api/EmailForwardingConfigRepository' as const,
  findByTeam: () => Effect.succeed(configRowOverride),
  upsert: (rawInput: unknown) => {
    const input = rawInput as UpsertCall;
    upsertCalls.push(input);
    // Return a row reflecting the call
    return Effect.succeed(
      makeConfig({
        imap_enabled: input.imap_enabled ?? false,
        imap_host: input.imap_host ?? Option.none(),
        imap_port: input.imap_port ?? Option.none(),
        imap_username: input.imap_username ?? Option.none(),
        imap_secret_encrypted: input.imap_secret_encrypted ?? Option.none(),
        imap_use_tls: input.imap_use_tls ?? true,
        imap_folder: input.imap_folder ?? Option.none(),
      }),
    );
  },
  findByInboundToken: () => Effect.succeed(Option.none()),
  regenerateToken: () => Effect.die(new Error('not implemented')),
  findImapEnabled: () => Effect.succeed([]),
  updateImapSync: () => Effect.void,
} as never);

// ---------------------------------------------------------------------------
// EmailSecretCrypto layer using a real AES-256-GCM implementation via makeWithKey.
// This gives us a real encrypt/decrypt for the test so we can assert the secret
// stored in the repo differs from the plaintext input.
// ---------------------------------------------------------------------------

const TestEmailSecretCryptoLayer = Layer.effect(
  EmailSecretCrypto,
  makeWithKey(Option.some(TEST_KEY_B64)),
);

// ---------------------------------------------------------------------------
// Other mocks (mirrors email-forwarding.test.ts)
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([['coach-token', COACH_USER_ID]]);

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
]);

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

const MockEmailMessagesRepositoryLayer = Layer.succeed(EmailMessagesRepository, {
  _tag: 'api/EmailMessagesRepository' as const,
  insertReceived: () => Effect.die(new Error('not implemented')),
  findById: () => Effect.succeed(Option.none()),
  findReceivedBatch: () => Effect.succeed([]),
  claimForSummarizing: () => Effect.succeed(Option.none()),
  setSummaryPendingApproval: () => Effect.void,
  updateSummary: () => Effect.succeed(Option.none()),
  incrementAttemptsAndMaybeFail: () => Effect.void,
  approve: () => Effect.succeed(Option.none()),
  sendOriginal: () => Effect.succeed(Option.none()),
  dismiss: () => Effect.succeed(Option.none()),
  setPosted: () => Effect.void,
} as never);

const MockEmailAttachmentsRepositoryLayer = Layer.succeed(EmailAttachmentsRepository, {
  _tag: 'api/EmailAttachmentsRepository' as const,
  insertMany: () => Effect.void,
  listMetaByEmail: () => Effect.succeed([]),
  findByIdWithBytes: () => Effect.succeed(Option.none()),
} as never);

const MockEmailPostSyncEventsRepositoryLayer = Layer.succeed(EmailPostSyncEventsRepository, {
  _tag: 'api/EmailPostSyncEventsRepository' as const,
  enqueue: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

const MockEmailApprovalServiceLayer = EmailApprovalService.Default.pipe(
  Layer.provide(MockEmailMessagesRepositoryLayer),
  Layer.provide(MockEmailPostSyncEventsRepositoryLayer),
);

// ---------------------------------------------------------------------------
// Build test layer (mirrors email-forwarding.test.ts TestLayer structure)
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
  // Email repos
  Layer.provide(MockEmailMessagesRepositoryLayer),
  Layer.provide(MockEmailAttachmentsRepositoryLayer),
  Layer.provide(MockEmailForwardingConfigRepositoryLayer),
  Layer.provide(MockEmailPostSyncEventsRepositoryLayer),
  // Crypto with test key (merged with approval service to stay within Layer.pipe arity limit)
  Layer.provide(Layer.merge(MockEmailApprovalServiceLayer, TestEmailSecretCryptoLayer)),
  // Remaining repos (noop)
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

const configUrl = (teamId: string) => `http://localhost/teams/${teamId}/email-forwarding`;

// ---------------------------------------------------------------------------
// Helper: valid PUT payload
// ---------------------------------------------------------------------------

const makePutPayload = (withSecret: boolean, secretValue?: string): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    enabled: true,
    target_channel_id: '111111111111111111',
    coach_channel_id: '222222222222222222',
    monitored_addresses: [],
    imap_enabled: true,
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_username: 'user@example.com',
    imap_use_tls: true,
    imap_folder: 'INBOX',
  };
  if (withSecret) {
    base.imap_secret = secretValue ?? 'plaintext-pw';
  }
  // When withSecret=false, imap_secret key is OMITTED entirely (not null)
  return base;
};

// ---------------------------------------------------------------------------
// Test 1: PUT with imap_secret → encrypted in repo call; response has imapSecretSet=true; no plain secret in JSON
// ---------------------------------------------------------------------------

describe('PUT /teams/:teamId/email-forwarding — IMAP with secret', () => {
  it('upsert receives encrypted secret (≠ plaintext); response has imapSecretSet=true; no plain secret in JSON', async () => {
    const body = JSON.stringify(makePutPayload(true, 'plaintext-pw'));

    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer coach-token',
          'Content-Type': 'application/json',
        },
        body,
      }),
    );

    expect(response.status).toBe(200);

    // Assert repo received an encrypted secret (not the plaintext)
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(Option.isSome(call.imap_secret_encrypted)).toBe(true);
    const stored = Option.getOrThrow(call.imap_secret_encrypted);
    expect(stored).not.toBe('plaintext-pw');
    // Should be a v1. blob
    expect(stored.startsWith('v1.')).toBe(true);

    // Response view should have imapSecretSet=true
    const responseBody = await response.json();
    expect(responseBody.imapSecretSet).toBe(true);

    // Serialized JSON must not contain plaintext password
    const jsonText = JSON.stringify(responseBody);
    expect(jsonText).not.toContain('plaintext-pw');
    // Must not contain any raw secret field (imapSecretSet is a boolean flag, not a secret value)
    expect(jsonText).not.toContain('"imapSecret":');
    expect(jsonText).not.toContain('imap_secret_encrypted');
    expect(jsonText).not.toContain('imap_secret"');
  });

  it('other IMAP fields in the response match what was PUT', async () => {
    const body = JSON.stringify(makePutPayload(true, 'any-pw'));

    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer coach-token',
          'Content-Type': 'application/json',
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    // These imap fields should be reflected in the view
    expect(responseBody.imapEnabled).toBe(true);
    expect(responseBody.imapHost).toBe('imap.example.com');
    expect(responseBody.imapPort).toBe(993);
    expect(responseBody.imapUsername).toBe('user@example.com');
    expect(responseBody.imapUseTls).toBe(true);
    expect(responseBody.imapFolder).toBe('INBOX');
  });
});

// ---------------------------------------------------------------------------
// Test 2: GET returns imapSecretSet=true when secret is Some; no secret in JSON
// ---------------------------------------------------------------------------

describe('GET /teams/:teamId/email-forwarding — IMAP secret is set', () => {
  it('GET when row has imap_secret_encrypted=Some → imapSecretSet=true, no secret in JSON', async () => {
    // Override the config row returned by findByTeam to have a secret
    configRowOverride = Option.some(
      makeConfig({
        imap_enabled: true,
        imap_secret_encrypted: Option.some('enc-blob'),
        imap_host: Option.some('imap.example.com' as unknown as any),
        imap_port: Option.some(993),
        imap_username: Option.some('user@example.com' as unknown as any),
      }),
    );

    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();

    // imapSecretSet must be true
    expect(responseBody.imapSecretSet).toBe(true);

    // The raw secret must NOT appear anywhere in the serialized response
    const jsonText = JSON.stringify(responseBody);
    expect(jsonText).not.toContain('enc-blob');
    expect(jsonText).not.toContain('imap_secret_encrypted');
    expect(jsonText).not.toContain('imapSecret"');
  });

  it('GET when row has imap_secret_encrypted=None → imapSecretSet=false', async () => {
    configRowOverride = Option.some(
      makeConfig({
        imap_enabled: true,
        imap_secret_encrypted: Option.none(),
      }),
    );

    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.imapSecretSet).toBe(false);
  });

  it('GET when no config row exists → defaultConfigView has imapSecretSet=false', async () => {
    // configRowOverride remains None (default)
    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        headers: { Authorization: 'Bearer coach-token' },
      }),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.imapSecretSet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: PUT WITHOUT imap_secret → repo receives imap_secret_encrypted=None (preserve path)
// ---------------------------------------------------------------------------

describe('PUT /teams/:teamId/email-forwarding — IMAP without secret (preserve path)', () => {
  it('PUT with imap_secret key absent → upsert receives imap_secret_encrypted=None', async () => {
    const body = JSON.stringify(makePutPayload(false)); // no imap_secret key

    const response = await handler(
      new Request(configUrl(TEAM_ID), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer coach-token',
          'Content-Type': 'application/json',
        },
        body,
      }),
    );

    expect(response.status).toBe(200);

    // Repo must receive imap_secret_encrypted=None (signals "keep existing")
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(Option.isNone(call.imap_secret_encrypted)).toBe(true);
  });
});
