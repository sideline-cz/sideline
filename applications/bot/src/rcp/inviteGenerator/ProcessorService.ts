import type { InviteAcceptance, Onboarding } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Duration, Effect, Metric, Option, type ServiceMap } from 'effect';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyInviteGeneratorError } from './errorClassifier.js';

const inviteGeneratorTotal = Metric.counter('invite_generator_total', {
  description: 'Total Discord invite generation operations',
  incremental: true,
});

// CC-0 / blocker 2: a 429 burst must not hold the poll loop hostage. `retry_after` is honoured
// but capped so a single tick can never outlast the CC-4 sweep window.
const MAX_RETRY_SLEEP_SECONDS = 30;

// PR-2 wire expand (CC-1) / PR-3 contract: `welcome_channel_id` is `Option` and `bot_present` is
// a real column (`LEFT JOIN bot_guilds`) — both are now genuinely emitted by the server.
export interface PendingAcceptance {
  readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
  readonly guild_id: string;
  readonly welcome_channel_id: Option.Option<string>;
  readonly bot_present: boolean;
}

const markTerminallyFailed = (
  rpc: SyncRpcClient,
  acceptance: PendingAcceptance,
  errorCode: Onboarding.InviteGeneratorErrorCode,
  errorDetail: string,
  logMessage: string,
) =>
  rpc['Invite/MarkAcceptanceFailed']({
    acceptance_id: acceptance.acceptance_id,
    error_code: errorCode,
    error_detail: errorDetail,
  }).pipe(
    Effect.tap(() => Effect.logWarning(logMessage)),
    Effect.tap(() =>
      Metric.update(Metric.withAttributes(inviteGeneratorTotal, { status: 'failed' }), 1),
    ),
    Effect.catchTag('RpcClientError', (e) =>
      Effect.logError(
        `MarkAcceptanceFailed RPC failed for acceptance ${acceptance.acceptance_id}`,
        e,
      ),
    ),
  );

const processWelcomeChannel = (
  rpc: SyncRpcClient,
  discord: ServiceMap.Service.Shape<typeof DiscordREST>,
  acceptance: PendingAcceptance,
) =>
  Option.match(acceptance.welcome_channel_id, {
    // CC-0 rule 2: fixable by a captain setting the welcome channel (`TeamSettingsPage.tsx` ->
    // `updateTeamInfo`), so `findPending` re-opens this row once `teams.welcome_channel_id`
    // becomes non-null. Terminal in the meantime — a human action is required.
    onNone: () =>
      markTerminallyFailed(
        rpc,
        acceptance,
        'welcome_channel_missing',
        'Team has no welcome channel configured',
        `Discord invite generation skipped for acceptance ${acceptance.acceptance_id} — no welcome channel configured`,
      ),
    onSome: (welcomeChannelId) =>
      discord
        .createChannelInvite(welcomeChannelId, {
          max_age: 86400,
          max_uses: 1,
          unique: true,
          temporary: false,
        })
        .pipe(
          Effect.flatMap((response) =>
            rpc['Invite/SetAcceptanceDiscordCode']({
              acceptance_id: acceptance.acceptance_id,
              discord_code: response.code,
            }).pipe(
              Effect.tap(() =>
                Effect.logInfo(
                  `Generated 1-use Discord invite ${response.code} for acceptance ${acceptance.acceptance_id}`,
                ),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(inviteGeneratorTotal, { status: 'success' }),
                  1,
                ),
              ),
            ),
          ),
          // CC-0 / blocker 2: a first failure is not automatically terminal. The classifier says
          // which; only a terminal classification is allowed to write `discord_code_error_code`.
          Effect.catch((error) => {
            const classified = classifyInviteGeneratorError(error);

            return classified.terminal
              ? markTerminallyFailed(
                  rpc,
                  acceptance,
                  classified.code,
                  classified.detail,
                  `Discord invite generation failed for acceptance ${acceptance.acceptance_id}: ${classified.code}`,
                )
              : Effect.logWarning(
                  `Discord invite generation transiently failed for acceptance ${acceptance.acceptance_id} (${classified.code}); leaving row open for the next poll`,
                  error,
                ).pipe(
                  Effect.tap(() =>
                    Metric.update(
                      Metric.withAttributes(inviteGeneratorTotal, { status: 'transient' }),
                      1,
                    ),
                  ),
                  Effect.tap(() =>
                    classified.retry_after !== undefined
                      ? Effect.sleep(
                          Duration.seconds(
                            Math.min(classified.retry_after, MAX_RETRY_SLEEP_SECONDS),
                          ),
                        )
                      : Effect.void,
                  ),
                );
          }),
        ),
  });

const makeProcessAcceptance =
  (rpc: SyncRpcClient, discord: ServiceMap.Service.Shape<typeof DiscordREST>) =>
  (acceptance: PendingAcceptance): Effect.Effect<void> =>
    (acceptance.bot_present
      ? processWelcomeChannel(rpc, discord, acceptance)
      : // Checked ahead of the welcome-channel branch (test 15 pins the precedence): the bot
        // being absent from the guild is the more actionable fact. Terminal — a human must
        // re-invite the bot; CC-14's regenerate primitive is the recovery path.
        markTerminallyFailed(
          rpc,
          acceptance,
          'bot_not_in_guild',
          `Bot is not present in guild ${acceptance.guild_id}`,
          `Discord invite generation skipped for acceptance ${acceptance.acceptance_id} — bot not in guild ${acceptance.guild_id}`,
        )
    ).pipe(
      Effect.asVoid,
      Effect.withSpan('sync/invite_generator', {
        attributes: {
          'acceptance.id': acceptance.acceptance_id,
          'guild.id': acceptance.guild_id,
          'channel.id': Option.getOrElse(acceptance.welcome_channel_id, () => 'none'),
        },
      }),
    );

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.let('processAcceptance', ({ rpc, discord }) => makeProcessAcceptance(rpc, discord)),
  Effect.tap(() => Effect.logInfo('InviteGeneratorService initialized')),
  Effect.let('processTick', ({ rpc, processAcceptance }) =>
    rpc['Invite/PendingAcceptances']({ limit: 20 }).pipe(
      Effect.tap((acceptances) =>
        Effect.logDebug(`Invite generator poll: ${acceptances.length} acceptance(s)`),
      ),
      Effect.flatMap((acceptances) =>
        acceptances.length === 0
          ? Effect.void
          : Effect.all(Array.map(acceptances, processAcceptance), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${acceptances.length} Discord invite generation(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling pending invite acceptances', error),
      ),
      Effect.catchTag('RpcClientError', (error) =>
        Effect.logError('Unhandled error in invite generator poll', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('discord'),
  Bind.remove('processAcceptance'),
);
