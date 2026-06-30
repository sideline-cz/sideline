import type { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Effect } from 'effect';
import { formatPersonalChannelName } from '~/rest/channels/formatPersonalChannelName.js';
import { POLL_BATCH_SIZE, retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Discord "Unknown Channel" error code — the channel is already gone. */
const UNKNOWN_CHANNEL = 10003;

/**
 * Renames existing personal channels whose name was rendered with an outdated
 * channel-name format (the team changed `discord_personal_events_channel_format`).
 *
 * Per member: render the new name, rename the Discord channel, then record the
 * applied format so it stops being flagged. The applied format is only recorded
 * once the rename lands (or Discord reports the channel gone), so a transient
 * failure simply retries on the next tick. Serialized per guild for rate limits.
 */
export const renamePersonalChannels = (guildId: DiscordSchemas.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('members', ({ rpc }) =>
      rpc['Guild/GetPersonalChannelsToRename']({ guild_id: guildId, limit: POLL_BATCH_SIZE }),
    ),
    Effect.tap(({ members }) =>
      members.length > 0
        ? Effect.logDebug(`Guild ${guildId}: renaming ${members.length} personal events channel(s)`)
        : Effect.void,
    ),
    Effect.flatMap(({ rpc, rest, members }) =>
      Effect.all(
        Arr.map(members, (member) => {
          const newName = formatPersonalChannelName(
            member.channel_format,
            member.name,
            member.discord_id,
          );
          // Record the applied format so this channel is no longer flagged as drifted.
          const markApplied = rpc['Guild/SavePersonalChannelFormat']({
            team_id: member.team_id,
            team_member_id: member.team_member_id,
            channel_format: member.channel_format,
          }).pipe(
            Effect.catchTag('RpcClientError', (e) =>
              Effect.logWarning(
                `Failed to record applied format for member ${member.team_member_id}`,
                e,
              ),
            ),
            Effect.asVoid,
          );

          return rest
            .updateChannel(member.discord_channel_id, { name: newName })
            .pipe(Effect.retry(retryPolicy))
            .pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  markApplied.pipe(
                    Effect.andThen(
                      rpc['Guild/UpdateChannelName']({
                        channel_id: member.discord_channel_id,
                        name: newName,
                      }).pipe(Effect.catchTag('RpcClientError', () => Effect.void)),
                    ),
                  ),
                onFailure: (error) =>
                  error._tag === 'ErrorResponse' && error.data.code === UNKNOWN_CHANNEL
                    ? markApplied
                    : Effect.logWarning(
                        `Failed to rename personal channel ${member.discord_channel_id} for member ${member.team_member_id}; will retry`,
                        error,
                      ),
              }),
            );
        }),
        { concurrency: 1 },
      ),
    ),
    Effect.asVoid,
  );
