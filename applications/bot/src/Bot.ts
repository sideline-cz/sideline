import type { DiscordREST } from 'dfx/DiscordREST';
import { type DiscordGateway, runIx } from 'dfx/gateway';
import { Effect, Schedule } from 'effect';
import { commandBuilder } from '~/commands/index.js';
import { eventHandlers } from '~/events/index.js';
import { interactionBuilder } from '~/interactions/index.js';
import { recoverDeletedMessages } from '~/rcp/event/recoverDeletedMessages.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { APP_VERSION } from '~/version.js';
import {
  AchievementSyncService,
  ChannelSyncService,
  EventSyncService,
  GuildJoinSyncService,
  InviteGeneratorService,
  OnboardingSyncService,
  RoleProvisionSyncService,
  RoleSyncService,
  WeeklySummarySyncService,
} from './index.js';

const ixProgram = Effect.succeed(commandBuilder).pipe(
  Effect.map((cb) => cb.concat(interactionBuilder)),
  Effect.andThen(
    runIx((effect) =>
      // Top-level interaction error boundary — catches all causes including defects
      Effect.catchCause(effect, (cause) => Effect.logError('Interaction error', cause)),
    ),
  ),
);

const pollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  processTick.pipe(Effect.repeat(Schedule.spaced('5 seconds')));

const fastPollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  processTick.pipe(Effect.repeat(Schedule.spaced('1 seconds')));

export const program = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('reportVersion', ({ rpc }) =>
    rpc['BotInfo/ReportBotInfo']({ version: APP_VERSION }).pipe(
      Effect.timeout('5 seconds'),
      Effect.catchCause((cause) => Effect.logWarning('Failed to report bot version', cause)),
      Effect.forkDetach,
    ),
  ),
  Effect.bind('events', () => eventHandlers),
  Effect.bind('roles', () => RoleSyncService.asEffect()),
  Effect.bind('channels', () => ChannelSyncService.asEffect()),
  Effect.bind('eventSync', () => EventSyncService.asEffect()),
  Effect.bind('guildJoin', () => GuildJoinSyncService.asEffect()),
  Effect.bind('inviteGenerator', () => InviteGeneratorService.asEffect()),
  Effect.bind('onboarding', () => OnboardingSyncService.asEffect()),
  Effect.bind('achievements', () => AchievementSyncService.asEffect()),
  Effect.bind('roleProvision', () => RoleProvisionSyncService.asEffect()),
  Effect.bind('weeklySummary', () => WeeklySummarySyncService.asEffect()),
  Effect.tap(() => Effect.logInfo('Bot connected to Discord')),
  Effect.andThen(
    ({
      events,
      roles,
      channels,
      eventSync,
      guildJoin,
      inviteGenerator,
      onboarding,
      achievements,
      roleProvision,
      weeklySummary,
    }) =>
      Effect.all(
        [
          ixProgram,
          ...events,
          pollLoop(roles.processTick),
          pollLoop(channels.processTick),
          pollLoop(eventSync.processTick),
          pollLoop(guildJoin.processTick),
          fastPollLoop(inviteGenerator.processTick),
          pollLoop(onboarding.processTick),
          pollLoop(achievements.processTick),
          pollLoop(roleProvision.processTick),
          pollLoop(weeklySummary.processTick),
          recoverDeletedMessages,
        ],
        {
          concurrency: 'unbounded',
        },
      ),
  ),
  Effect.asVoid,
) as Effect.Effect<
  void,
  unknown,
  | DiscordGateway
  | DiscordREST
  | SyncRpc
  | RoleSyncService
  | ChannelSyncService
  | EventSyncService
  | GuildJoinSyncService
  | InviteGeneratorService
  | OnboardingSyncService
  | AchievementSyncService
  | RoleProvisionSyncService
  | WeeklySummarySyncService
>;
