import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleGroupDetached = (event: ChannelRpcEvents.GroupChannelDetachedEvent) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          Option.match(event.discord_role_id, {
            onNone: () => Effect.void,
            onSome: (roleId) =>
              Effect.Do.pipe(
                Effect.bind('rest', () => DiscordREST.asEffect()),
                Effect.tap(({ rest }) =>
                  rest
                    .deleteChannelPermissionOverwrite(channelId, roleId)
                    .pipe(Effect.retry(retryPolicy)),
                ),
                Effect.asVoid,
              ),
          }),
      }),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Detached Discord channel from group ${event.group_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );

export const handleRosterDetached = (event: ChannelRpcEvents.RosterChannelDetachedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
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
