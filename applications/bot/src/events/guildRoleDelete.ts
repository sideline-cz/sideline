import { Discord } from '@sideline/domain';
import { Effect, Schema } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

export const handleGuildRoleDelete = (payload: {
  guild_id: string;
  role_id: string;
}): Effect.Effect<void, never, SyncRpc> =>
  SyncRpc.asEffect().pipe(
    Effect.flatMap((rpc) =>
      rpc['Guild/DeleteGuildRole']({
        guild_id: decodeSnowflake(payload.guild_id),
        role_id: decodeSnowflake(payload.role_id),
      }),
    ),
    Effect.catchTag('RpcClientError', (e) =>
      Effect.logWarning(`Failed to delete role ${payload.role_id}`, e),
    ),
    Effect.asVoid,
  );
