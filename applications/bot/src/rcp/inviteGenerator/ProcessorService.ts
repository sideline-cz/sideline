import type { InviteAcceptance } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Metric, Option, type ServiceMap } from 'effect';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyInviteGeneratorError } from './errorClassifier.js';

const inviteGeneratorTotal = Metric.counter('invite_generator_total', {
  description: 'Total Discord invite generation operations',
  incremental: true,
});

// PR-2 wire expand (CC-1): `welcome_channel_id` is now `Option` (tolerates a missing key or an
// explicit `null` from the widened `Invite/PendingAcceptances` schema) and `bot_present` is
// added, decoding to `true` when an old-shaped payload omits it. Neither PR-2 producer (server
// or bot) actually emits `None` / `false` yet — this release is behaviour-neutral by design.
export interface PendingAcceptance {
  readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
  readonly guild_id: string;
  readonly welcome_channel_id: Option.Option<string>;
  readonly bot_present: boolean;
}

const makeProcessAcceptance =
  (rpc: SyncRpcClient, discord: ServiceMap.Service.Shape<typeof DiscordREST>) =>
  (acceptance: PendingAcceptance): Effect.Effect<void> =>
    Option.match(acceptance.welcome_channel_id, {
      // Finally reachable in code, even though the server's temporary wire guard
      // (`InviteAcceptancesRepository.findPending`) makes this unreachable in production this
      // release — PR-3 lifts that guard, at which point this is a one-line SQL change, not a
      // bot deploy.
      onNone: () =>
        rpc['Invite/MarkAcceptanceFailed']({
          acceptance_id: acceptance.acceptance_id,
          error_code: 'welcome_channel_missing',
          error_detail: 'Team has no welcome channel configured',
        }).pipe(
          Effect.tap(() =>
            Effect.logWarning(
              `Discord invite generation skipped for acceptance ${acceptance.acceptance_id} — no welcome channel configured`,
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
            // PR-3 splits this classifier further (e.g. the `bot_not_in_guild` gate); this
            // release keeps it exactly as it was.
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
                  Metric.update(
                    Metric.withAttributes(inviteGeneratorTotal, { status: 'failed' }),
                    1,
                  ),
                ),
                Effect.catchTag('RpcClientError', (e) =>
                  Effect.logError(
                    `MarkAcceptanceFailed RPC failed for acceptance ${acceptance.acceptance_id}`,
                    e,
                  ),
                ),
              );
            }),
          ),
    }).pipe(
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
