import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { SyncRpc } from '../../services/SyncRpc.js';

export interface PendingGuildJoin {
  readonly id: string;
  readonly guild_id: string;
  readonly discord_id: string;
  readonly access_token: string;
}

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: PendingGuildJoin) =>
        discord
          .addGuildMember(event.guild_id, event.discord_id, {
            access_token: event.access_token,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo(
                `Added user ${event.discord_id} to guild ${event.guild_id} via invite join`,
              ),
            ),
            Effect.flatMap(() => rpc['Guild/MarkGuildJoinDone']({ id: event.id })),
            Effect.tap(() =>
              Metric.update(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'guild_join' }),
                1,
              ),
            ),
            Effect.catch((error) =>
              rpc['Guild/MarkGuildJoinFailed']({ id: event.id, error: String(error) }).pipe(
                Effect.tap(() =>
                  Effect.logWarning(`Failed to add user ${event.discord_id} to guild`, error),
                ),
                Effect.tap(() =>
                  Metric.update(
                    Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'guild_join' }),
                    1,
                  ),
                ),
              ),
            ),
            Effect.provideService(SyncRpc, rpc),
            Effect.provideService(DiscordREST, discord),
            Effect.withSpan('sync/guild_join', {
              attributes: { 'event.id': event.id, 'guild.id': event.guild_id },
            }),
          ),
  ),
);

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('processEvent', ({ rpc, discord }) =>
    processEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
    ),
  ),
  Effect.tap(() => Effect.logInfo('GuildJoinSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['Guild/PendingGuildJoins']().pipe(
      Effect.tap((events) => Effect.logDebug(`Guild-join sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} guild-join sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling guild-join sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
