import { SyncRpcs } from '@sideline/domain';
import { Layer } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApiSwagger } from 'effect/unstable/httpapi';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { Api } from '~/api/api.js';
import { EmailWebhookLive } from '~/api/email-webhook.js';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { RpcObservability, RpcObservabilityLive } from '~/middleware/RpcObservability.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DashboardLayoutsRepository } from '~/repositories/DashboardLayoutsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
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
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamOnboardingTokensRepository } from '~/repositories/TeamOnboardingTokensRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  WeeklySummaryRepository,
  WeeklySummarySyncEventsRepository,
} from '~/repositories/WeeklySummaryRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { EmailApprovalService } from '~/services/EmailApprovalService.js';
import { EmailSecretCrypto } from '~/services/EmailSecretCrypto.js';
import { LlmClient } from '~/services/LlmClient.js';
import { TranslationCache } from '~/services/TranslationCache.js';
import { env } from './env.js';
import { HttpLogger } from './middleware/HttpLogger.js';
import { SyncRpcsLive } from './rpc/index.js';

const ObservableSyncRpcs = SyncRpcs.SyncRpcs.middleware(RpcObservability);

const RpcLive = RpcServer.layer(ObservableSyncRpcs).pipe(
  Layer.provide(SyncRpcsLive),
  Layer.provide(RpcObservabilityLive),
  Layer.provide(
    RpcServer.layerProtocolHttp({
      path: env.RPC_PREFIX as HttpRouter.PathInput,
    }),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
);

const Repositories = Layer.mergeAll(
  UsersRepository.Default,
  SessionsRepository.Default,
  TeamsRepository.Default,
  BotGuildsRepository.Default,
  TeamMembersRepository.Default,
  RostersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TrainingTypesRepository.Default,
  TeamInvitesRepository.Default,
  TeamOnboardingTokensRepository.Default,
  InviteAcceptancesRepository.Default,
  AgeThresholdRepository.Default,
  NotificationsRepository.Default,
  RoleSyncEventsRepository.Default,
  DiscordRoleMappingRepository.Default,
  ChannelSyncEventsRepository.Default,
  EventSyncEventsRepository.Default,
  DiscordChannelMappingRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  EventsRepository.Default,
  EventRsvpsRepository.Default,
  ChannelEventDividersRepository.Default,
  ICalTokensRepository.Default,
  EventSeriesRepository.Default,
  TeamSettingsRepository.Default,
  OAuthConnectionsRepository.Default,
  ActivityLogsRepository.Default,
  ActivityTypesRepository.Default,
  LeaderboardRepository.Default,
  PendingGuildJoinsRepository.Default,
  EarnedAchievementsRepository.Default,
  AchievementRoleMappingsRepository.Default,
  AchievementSyncEventsRepository.Default,
  AchievementSettingsRepository.Default,
  CustomAchievementsRepository.Default,
  DashboardLayoutsRepository.Default,
  DiscordRoleProvisionEventsRepository.Default,
  TeamChallengeRepository.Default,
  WeeklySummaryRepository.Default,
  WeeklySummarySyncEventsRepository.Default,
  TranslationsRepository.Default,
  FeesRepository.Default,
  FeeAssignmentsRepository.Default,
  PaymentsRepository.Default,
  FinanceOverviewRepository.Default,
  ExpensesRepository.Default,
  PaymentReminderSyncEventsRepository.Default,
  PaymentRemindersSentRepository.Default,
  CarpoolsRepository.Default,
  TeamChannelsRepository.Default,
  TeamChannelAccessRepository.Default,
  EmailForwardingConfigRepository.Default,
  EmailMessagesRepository.Default,
  EmailAttachmentsRepository.Default,
  EmailPostSyncEventsRepository.Default,
);

const AppLayer = Layer.mergeAll(
  ApiLive,
  HttpApiSwagger.layer(Api, { path: '/docs/swagger-ui' }),
  HttpRouter.cors({ credentials: true }),
  RpcLive,
  EmailWebhookLive,
);

export const AppLive = HttpRouter.serve(AppLayer, { middleware: HttpLogger }).pipe(
  HttpServer.withLogAddress,
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(AgeCheckService.Default),
  Layer.provide(AchievementEvaluator.Default),
  Layer.provide(AchievementPreview.Default),
  Layer.provide(BotInfoStore.Default),
  Layer.provide(TranslationCache.Default),
  Layer.provide(
    Layer.merge(Repositories, EmailApprovalService.Default.pipe(Layer.provide(Repositories))),
  ),
  Layer.provide(DiscordOAuth.Default),
  Layer.provide(LlmClient.Default),
  Layer.provide(EmailSecretCrypto.Default),
  Layer.provide(FetchHttpClient.layer),
);
