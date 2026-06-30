import type { DiscordREST } from 'dfx/DiscordREST';
import { type DiscordGateway, runIx } from 'dfx/gateway';
import { Cause, Effect, Metric, Schedule } from 'effect';
import { commandBuilder } from '~/commands/index.js';
import { eventHandlers } from '~/events/index.js';
import { interactionBuilder } from '~/interactions/index.js';
import { syncEventsFailedTotal } from '~/metrics.js';
import { recoverDeletedMessages } from '~/rcp/event/recoverDeletedMessages.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { APP_VERSION } from '~/version.js';
import {
  AchievementSyncService,
  ChannelBackfillService,
  ChannelSyncService,
  EmailSyncService,
  EventSyncService,
  FinanceSyncService,
  GuildJoinSyncService,
  InviteGeneratorService,
  OnboardingSyncService,
  PersonalEventsSyncService,
  RoleProvisionSyncService,
  RoleSyncService,
  TeamChallengeSyncService,
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

// ---------------------------------------------------------------------------
// Transient upstream error classifier
// ---------------------------------------------------------------------------

/**
 * Returns true when the value looks like a transient upstream blip that is safe
 * to downgrade from Error to Warning severity.
 * Covers:
 * - SyntaxError instances (NDJSON JSON.parse failures on e.g. 502 HTML bodies)
 * - Objects whose `.message` includes 'is not valid JSON'
 * - Objects with a `.response.status` that is a 5xx HTTP status code
 * - Plain strings containing 'is not valid JSON'
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const isTransientUpstreamValue = (value: unknown): boolean => {
  if (value instanceof SyntaxError) return true;
  if (typeof value === 'string') return value.includes('is not valid JSON');
  const v = asRecord(value);
  if (v === undefined) return false;
  if (typeof v.message === 'string' && v.message.includes('is not valid JSON')) return true;
  const status = asRecord(v.response)?.status;
  return typeof status === 'number' && status >= 500;
};

/**
 * Returns true when a poll tick `Cause` contains at least one reason that looks
 * like a transient upstream blip (502 HTML body → NDJSON JSON.parse SyntaxError,
 * 5xx response status, etc.).
 *
 * Iterates `cause.reasons` directly (Effect 4.0 flat cause model).
 */
export const isTransientPollError = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (Cause.isFailReason(reason)) return isTransientUpstreamValue(reason.error);
    if (Cause.isDieReason(reason)) return isTransientUpstreamValue(reason.defect);
    return false; // interrupts are not transient upstream blips
  });

// ---------------------------------------------------------------------------
// Resilient poll tick wrapper
// ---------------------------------------------------------------------------

// A poll tick that fails (or dies) must NOT kill the repeat loop: `Effect.repeat`
// stops on the first failure, which would silently stop a poller forever (until the
// bot is restarted) on a transient blip — e.g. an RPC error while the server is
// redeploying. Catch the whole cause, log it, and return void so the loop keeps
// ticking. Per-service `processTick`s already log the specific error via `tapError`;
// this is the safety net that also swallows defects. Mirrors the `ixProgram` boundary.
export const resilientTick = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  Effect.catchCause(processTick, (cause) =>
    isTransientPollError(cause)
      ? Metric.update(
          Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'poll_tick_transient' }),
          1,
        ).pipe(
          Effect.andThen(
            Effect.logWarning('Sync poll tick transient upstream error (will retry)', cause),
          ),
        )
      : Effect.logError('Sync poll tick failed', cause),
  );

const pollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  resilientTick(processTick).pipe(Effect.repeat(Schedule.spaced('5 seconds')));

const fastPollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  resilientTick(processTick).pipe(Effect.repeat(Schedule.spaced('1 seconds')));

const slowPollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  resilientTick(processTick).pipe(Effect.repeat(Schedule.spaced('5 minutes')));

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
  Effect.bind('teamChallenge', () => TeamChallengeSyncService.asEffect()),
  Effect.bind('weeklySummary', () => WeeklySummarySyncService.asEffect()),
  Effect.bind('finance', () => FinanceSyncService.asEffect()),
  Effect.bind('emailSync', () => EmailSyncService.asEffect()),
  Effect.bind('channelBackfill', () => ChannelBackfillService.asEffect()),
  Effect.bind('personalEvents', () => PersonalEventsSyncService.asEffect()),
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
      teamChallenge,
      weeklySummary,
      finance,
      emailSync,
      channelBackfill,
      personalEvents,
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
          pollLoop(teamChallenge.processTick),
          pollLoop(weeklySummary.processTick),
          pollLoop(finance.processTick),
          pollLoop(emailSync.processTick),
          slowPollLoop(channelBackfill.processTick),
          pollLoop(personalEvents.processTick),
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
  | ChannelBackfillService
  | EmailSyncService
  | EventSyncService
  | FinanceSyncService
  | GuildJoinSyncService
  | InviteGeneratorService
  | OnboardingSyncService
  | AchievementSyncService
  | RoleProvisionSyncService
  | TeamChallengeSyncService
  | WeeklySummarySyncService
  | PersonalEventsSyncService
>;
