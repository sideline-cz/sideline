import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { deleteRole } from './channelUtils.js';

export const handleDeleted = (event: ChannelRpcEvents.GroupChannelDeletedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.tap(() =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          Effect.Do.pipe(
            Effect.bind('rest', () => DiscordREST.asEffect()),
            Effect.tap(({ rest }) => rest.deleteChannel(channelId).pipe(Effect.retry(retryPolicy))),
            Effect.tap(() =>
              Effect.logInfo(`Deleted Discord channel ${channelId} in guild ${event.guild_id}`),
            ),
            Effect.asVoid,
          ),
      }),
    ),
    Effect.tap(() => deleteRole(event.guild_id, event.discord_role_id)),
    Effect.tap(({ rpc }) =>
      rpc['Channel/DeleteMapping']({ team_id: event.team_id, group_id: event.group_id }),
    ),
    Effect.asVoid,
  );

export const handleRosterDeleted = (event: ChannelRpcEvents.RosterChannelDeletedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) =>
      rest.deleteChannel(event.discord_channel_id).pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Deleted Discord channel ${event.discord_channel_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.tap(() => deleteRole(event.guild_id, event.discord_role_id)),
    Effect.tap(({ rpc }) =>
      rpc['Channel/DeleteRosterMapping']({ team_id: event.team_id, roster_id: event.roster_id }),
    ),
    Effect.tap(({ rpc }) =>
      rpc['Channel/UpdateRosterChannel']({
        roster_id: event.roster_id,
        discord_channel_id: Option.none(),
      }),
    ),
    Effect.asVoid,
  );
