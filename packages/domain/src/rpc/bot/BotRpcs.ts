import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';

// Server -> bot RPC. The bot SERVES this group and the server is the client, the reverse of SyncRpcs.
// Auth is `Authorization: Bearer <BOT_RPC_SECRET>`, a header OTEL redacts by default.
// Results stay plain Structs: an Option-wrapped Schema.Class result collapses AppLive's R.
export const PingResult = Schema.Struct({ version: Schema.String });
export type PingResult = typeof PingResult.Type;

export const BotRpcs = RpcGroup.make(Rpc.make('Ping', { success: PingResult })).prefix('Bot/');
