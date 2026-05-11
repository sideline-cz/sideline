import type { TeamInvite } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Metric, type ServiceMap } from 'effect';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyInviteGeneratorError } from './errorClassifier.js';

const inviteGeneratorTotal = Metric.counter('invite_generator_total', {
  description: 'Total Discord invite generation operations',
  incremental: true,
});

export interface PendingInvite {
  readonly invite_id: TeamInvite.TeamInviteId;
  readonly guild_id: string;
  readonly welcome_channel_id: string;
}

const makeProcessInvite =
  (rpc: SyncRpcClient, discord: ServiceMap.Service.Shape<typeof DiscordREST>) =>
  (invite: PendingInvite): Effect.Effect<void> =>
    discord
      .createChannelInvite(invite.welcome_channel_id, {
        max_age: 0,
        max_uses: 0,
        unique: true,
        temporary: false,
      })
      .pipe(
        Effect.flatMap((response) =>
          rpc['Invite/SetDiscordCode']({
            invite_id: invite.invite_id,
            discord_code: response.code,
          }).pipe(
            Effect.tap(() =>
              Effect.logInfo(
                `Generated Discord invite ${response.code} for team invite ${invite.invite_id}`,
              ),
            ),
            Effect.tap(() =>
              Metric.update(Metric.withAttributes(inviteGeneratorTotal, { status: 'success' }), 1),
            ),
          ),
        ),
        Effect.catch((error) => {
          const classified = classifyInviteGeneratorError(error);
          return rpc['Invite/MarkDiscordCodeFailed']({
            invite_id: invite.invite_id,
            error_code: classified.code,
            error_detail: classified.detail,
          }).pipe(
            Effect.tap(() =>
              Effect.logWarning(
                `Discord invite generation failed for invite ${invite.invite_id}`,
                error,
              ),
            ),
            Effect.tap(() =>
              Metric.update(Metric.withAttributes(inviteGeneratorTotal, { status: 'failed' }), 1),
            ),
            Effect.catchTag('RpcClientError', (e) =>
              Effect.logError(`MarkDiscordCodeFailed RPC failed for invite ${invite.invite_id}`, e),
            ),
          );
        }),
        Effect.asVoid,
        Effect.withSpan('sync/invite_generator', {
          attributes: {
            'invite.id': invite.invite_id,
            'guild.id': invite.guild_id,
            'channel.id': invite.welcome_channel_id,
          },
        }),
      );

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.let('processInvite', ({ rpc, discord }) => makeProcessInvite(rpc, discord)),
  Effect.tap(() => Effect.logInfo('InviteGeneratorService initialized')),
  Effect.let('processTick', ({ rpc, processInvite }) =>
    rpc['Invite/PendingDiscordCodes']({ limit: 20 }).pipe(
      Effect.tap((invites) =>
        Effect.logDebug(`Invite generator poll: ${invites.length} invite(s)`),
      ),
      Effect.flatMap((invites) =>
        invites.length === 0
          ? Effect.void
          : Effect.all(Array.map(invites, processInvite), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${invites.length} Discord invite generation(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling pending Discord invite codes', error),
      ),
      Effect.catchTag('RpcClientError', (error) =>
        Effect.logError('Unhandled error in invite generator poll', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('discord'),
  Bind.remove('processInvite'),
);
