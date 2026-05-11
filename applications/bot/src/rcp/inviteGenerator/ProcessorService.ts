import type { InviteAcceptance } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Metric, type ServiceMap } from 'effect';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyInviteGeneratorError } from './errorClassifier.js';

const inviteGeneratorTotal = Metric.counter('invite_generator_total', {
  description: 'Total Discord invite generation operations',
  incremental: true,
});

export interface PendingAcceptance {
  readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
  readonly guild_id: string;
  readonly welcome_channel_id: string;
}

const makeProcessAcceptance =
  (rpc: SyncRpcClient, discord: ServiceMap.Service.Shape<typeof DiscordREST>) =>
  (acceptance: PendingAcceptance): Effect.Effect<void> =>
    discord
      .createChannelInvite(acceptance.welcome_channel_id, {
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
              Metric.update(Metric.withAttributes(inviteGeneratorTotal, { status: 'success' }), 1),
            ),
          ),
        ),
        Effect.catch((error) => {
          const classified = classifyInviteGeneratorError(error);
          return rpc['Invite/MarkAcceptanceFailed']({
            acceptance_id: acceptance.acceptance_id,
            error_code: classified.code,
            error_detail: classified.detail,
          }).pipe(
            Effect.tap(() =>
              Effect.logWarning(
                `Discord invite generation failed for acceptance ${acceptance.acceptance_id}`,
                error,
              ),
            ),
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
        }),
        Effect.asVoid,
        Effect.withSpan('sync/invite_generator', {
          attributes: {
            'acceptance.id': acceptance.acceptance_id,
            'guild.id': acceptance.guild_id,
            'channel.id': acceptance.welcome_channel_id,
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
