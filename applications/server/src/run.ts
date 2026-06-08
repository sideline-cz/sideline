import { createServer } from 'node:http';
import { NodeFileSystem, NodeHttpServer } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Runtime, Telemetry } from '@sideline/effect-lib';
import { AfterMigrator, BeforeMigrator } from '@sideline/migrations';
import { Config, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { env } from '~/env.js';
import { AppLive, HealthServerLive } from '~/index.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import {
  WeeklySummaryRepository,
  WeeklySummarySyncEventsRepository,
} from '~/repositories/WeeklySummaryRepository.js';
import { AgeCheckCron } from '~/services/AgeCheckCron.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { CoachingStatusCron } from '~/services/CoachingStatusCron.js';
import { EmailSummarizer } from '~/services/EmailSummarizer.js';
import { EventHorizonCron } from '~/services/EventHorizonCron.js';
import { EventStartCron } from '~/services/EventStartCron.js';
import { LlmClient } from '~/services/LlmClient.js';
import { PaymentReminderCron } from '~/services/PaymentReminderCron.js';
import { RsvpReminderCron } from '~/services/RsvpReminderCron.js';
import { TrainingAutoLogCron } from '~/services/TrainingAutoLogCron.js';
import { TrainingClaimRequestCron } from '~/services/TrainingClaimRequestCron.js';
import { WeeklySummaryCron } from '~/services/WeeklySummaryCron.js';

const BasePg: Config.Wrap<PgClient.PgClientConfig> = {
  host: Config.succeed(env.DATABASE_HOST),
  port: Config.succeed(env.DATABASE_PORT),
  database: Config.succeed(env.DATABASE_NAME),
  username: Config.succeed(env.DATABASE_USER),
  password: Config.succeed(env.DATABASE_PASS),
};

const CreateDb = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen((sql) => sql.unsafe(`CREATE DATABASE "${env.DATABASE_NAME}"`)),
  Effect.tap(Effect.logInfo),
  Effect.tapError(Effect.logWarning),
  // DB may already exist — error is logged above, then swallowed intentionally
  Effect.option,
  Effect.asVoid,
  Effect.provide(
    PgClient.layerConfig({
      ...BasePg,
      database: Config.succeed(env.DATABASE_MAIN),
    }),
  ),
);

const MigratorContext = Layer.merge(PgClient.layerConfig(BasePg), NodeFileSystem.layer);
const MigrateBefore = BeforeMigrator.pipe(Effect.provide(MigratorContext));
const MigrateAfter = AfterMigrator.pipe(Effect.provide(MigratorContext));

const App = AppLive.pipe(
  Layer.provide(PgClient.layerConfig(BasePg)),
  Layer.provide(NodeHttpServer.layer(createServer, { port: env.PORT })),
  Layer.launch,
  Effect.withSpan('app'),
);

const Health = HealthServerLive.pipe(Layer.launch, Effect.withSpan('health'));

const RepositoriesLive = Layer.mergeAll(
  AgeThresholdRepository.Default,
  NotificationsRepository.Default,
  GroupsRepository.Default,
  ChannelSyncEventsRepository.Default,
);

const Cron = AgeCheckCron.asEffect().pipe(
  Effect.provide(
    AgeCheckService.Default.pipe(
      Layer.provideMerge(RepositoriesLive),
      Layer.provideMerge(PgClient.layerConfig(BasePg)),
    ),
  ),
);

const EventHorizonRepositoriesLive = Layer.mergeAll(
  EventSeriesRepository.Default,
  EventsRepository.Default,
  TeamSettingsRepository.Default,
  EventSyncEventsRepository.Default,
  TrainingTypesRepository.Default,
  DiscordChannelMappingRepository.Default,
);

const HorizonCron = EventHorizonCron.asEffect().pipe(
  Effect.provide(
    EventHorizonRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const RsvpReminderRepositoriesLive = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  TeamSettingsRepository.Default,
  DiscordChannelMappingRepository.Default,
);

const ReminderCron = RsvpReminderCron.asEffect().pipe(
  Effect.provide(
    RsvpReminderRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const TrainingAutoLogRepositoriesLive = Layer.mergeAll(
  EventsRepository.Default,
  EventRsvpsRepository.Default,
  ActivityLogsRepository.Default,
  ActivityTypesRepository.Default,
);

const AutoLogCron = TrainingAutoLogCron.asEffect().pipe(
  Effect.provide(
    TrainingAutoLogRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const EventStartRepositoriesLive = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  // EventStartCron resolves reminder channels/roles via EventChannelResolver,
  // which requires DiscordChannelMappingRepository.
  DiscordChannelMappingRepository.Default,
);

const StartCron = EventStartCron.asEffect().pipe(
  Effect.provide(EventStartRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg)))),
);

const WeeklySummaryRepositoriesLive = Layer.mergeAll(
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  WeeklySummaryRepository.Default,
  WeeklySummarySyncEventsRepository.Default,
);

const WeeklySummaryCronEffect = WeeklySummaryCron.asEffect().pipe(
  Effect.provide(
    WeeklySummaryRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const PaymentReminderRepositoriesLive = Layer.mergeAll(
  FeeAssignmentsRepository.Default,
  PaymentReminderSyncEventsRepository.Default,
);

const PaymentReminderCronEffect = PaymentReminderCron.asEffect().pipe(
  Effect.provide(
    PaymentReminderRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const ClaimRequestRepositoriesLive = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  TeamSettingsRepository.Default,
  DiscordChannelMappingRepository.Default,
);

const ClaimRequestCronEffect = TrainingClaimRequestCron.asEffect().pipe(
  Effect.provide(
    ClaimRequestRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const CoachingStatusRepositoriesLive = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  TeamSettingsRepository.Default,
  DiscordChannelMappingRepository.Default,
);

const CoachingStatusCronEffect = CoachingStatusCron.asEffect().pipe(
  Effect.provide(
    CoachingStatusRepositoriesLive.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
);

const EmailSummarizerCronEffect = EmailSummarizer.asEffect().pipe(
  Effect.provide(
    EmailMessagesRepository.Default.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
  Effect.provide(
    EmailPostSyncEventsRepository.Default.pipe(Layer.provideMerge(PgClient.layerConfig(BasePg))),
  ),
  Effect.provide(LlmClient.Default),
);

Effect.Do.pipe(
  Effect.tap(() => (env.DATABASE_MAIN !== env.DATABASE_NAME ? CreateDb : Effect.void)),
  Effect.tap(() => MigrateBefore),
  Effect.andThen(() =>
    Effect.all(
      [
        App,
        Health,
        MigrateAfter,
        Cron,
        HorizonCron,
        ReminderCron,
        AutoLogCron,
        StartCron,
        WeeklySummaryCronEffect,
        PaymentReminderCronEffect,
        ClaimRequestCronEffect,
        CoachingStatusCronEffect,
        EmailSummarizerCronEffect,
      ],
      {
        // These are all long-running, never-completing supervised effects (HTTP
        // server, health, and the repeating cron loops). A bounded concurrency
        // smaller than the list length starves the tail — they never get a slot
        // because the earlier ones never complete. Run them all concurrently.
        concurrency: 'unbounded',
      },
    ),
  ),
  Runtime.runMain(
    env.NODE_ENV,
    env.LOG_LEVEL,
    Telemetry.makeTelemetryLayer({
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      environment: env.APP_ENV,
      origin: env.APP_ORIGIN,
    }),
  ),
);
