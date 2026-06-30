import type { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Effect } from 'effect';
import { POLL_BATCH_SIZE, retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Discord "Unknown Channel" error code — the channel is already gone. */
const UNKNOWN_CHANNEL = 10003;

/**
 * De-provisions personal channels for members who are no longer eligible (the
 * team restricted personal channels to a group and they fell outside it).
 *
 * Per member: delete the Discord channel, then clear the DB rows (channel +
 * rendered messages). The DB row is only cleared once the channel is gone (delete
 * succeeded, or Discord reports it already deleted) so a transient failure simply
 * retries on the next tick. Serialized per guild to respect Discord rate limits.
 */
export const deprovisionPersonalChannels = (guildId: DiscordSchemas.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('members', ({ rpc }) =>
      rpc['Guild/GetPersonalChannelsToDeprovision']({
        guild_id: guildId,
        limit: POLL_BATCH_SIZE,
      }),
    ),
    Effect.tap(({ members }) =>
      members.length > 0
        ? Effect.logDebug(
            `Guild ${guildId}: de-provisioning ${members.length} personal events channel(s)`,
          )
        : Effect.void,
    ),
    Effect.flatMap(({ rpc, rest, members }) =>
      Effect.all(
        Arr.map(members, (member) => {
          const clearDbRows = rpc['Guild/DeletePersonalChannel']({
            team_id: member.team_id,
            team_member_id: member.team_member_id,
          }).pipe(
            Effect.catchTag('RpcClientError', (e) =>
              Effect.logWarning(
                `Failed to clear personal channel rows for member ${member.team_member_id}`,
                e,
              ),
            ),
            Effect.asVoid,
          );

          return rest
            .deleteChannel(member.discord_channel_id)
            .pipe(Effect.retry(retryPolicy))
            .pipe(
              Effect.matchEffect({
                onSuccess: () => clearDbRows,
                onFailure: (error) =>
                  error._tag === 'ErrorResponse' && error.data.code === UNKNOWN_CHANNEL
                    ? clearDbRows
                    : Effect.logWarning(
                        `Failed to delete personal channel ${member.discord_channel_id} for member ${member.team_member_id}; will retry`,
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
