import { Discord } from '@sideline/domain';
import { Effect, Schema } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

export const handleGuildRoleUpdate = (payload: {
  guild_id: string;
  role: {
    id: string;
    name: string;
    color: number;
    position: number;
    managed: boolean;
  };
}): Effect.Effect<void, never, SyncRpc> =>
  SyncRpc.asEffect().pipe(
    Effect.flatMap((rpc) =>
      rpc['Guild/UpsertGuildRole']({
        guild_id: decodeSnowflake(payload.guild_id),
        role_id: decodeSnowflake(payload.role.id),
        name: payload.role.name,
        color: payload.role.color,
        position: payload.role.position,
        managed: payload.role.managed,
      }),
    ),
    Effect.catchTag('RpcClientError', (e) =>
      Effect.logWarning(`Failed to upsert role ${payload.role.id}`, e),
    ),
    Effect.asVoid,
  );
