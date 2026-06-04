import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { createChannelOnly } from '~/rest/channels/createChannelOnly.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleManagedCreated = (event: ChannelRpcEvents.ManagedChannelCreatedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('channelResult', () =>
      createChannelOnly(event.guild_id, event.discord_channel_name),
    ),
    Effect.tap(({ rpc, channelResult, rest }) =>
      rpc['Channel/UpsertManagedChannel']({
        team_channel_id: event.team_channel_id,
        discord_channel_id: channelResult.discord_channel_id,
      }).pipe(
        // Compensation: if the RPC upsert fails after a successful Discord channel creation,
        // delete the orphaned Discord channel so that a retry starts clean and does not
        // create a duplicate channel.
        // Assumption: this treats any UpsertManagedChannel failure as "channel not persisted
        // server-side". In an ambiguous timeout where the upsert actually persisted, the
        // compensating delete would orphan/duplicate the Discord channel. This is acceptable
        // for v1; revisit with an idempotent upsert keyed on discord_channel_id.
        Effect.catch((upsertError) =>
          rest
            .deleteChannel(channelResult.discord_channel_id)
            .pipe(
              Effect.retry(retryPolicy),
              Effect.tapError((deleteError) =>
                Effect.logWarning(
                  `Failed to delete orphaned Discord channel ${channelResult.discord_channel_id} during compensation`,
                  deleteError,
                ),
              ),
              Effect.catch(() => Effect.void),
            )
            .pipe(Effect.flatMap(() => Effect.fail(upsertError))),
        ),
      ),
    ),
    Effect.tap(({ channelResult }) =>
      Effect.logInfo(
        `Synced managed_channel_created: team_channel ${event.team_channel_id} → Discord channel ${channelResult.discord_channel_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
