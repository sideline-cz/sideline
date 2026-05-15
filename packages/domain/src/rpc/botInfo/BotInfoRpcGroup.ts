import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';

export const BotInfoRpcGroup = RpcGroup.make(
  Rpc.make('ReportBotInfo', {
    payload: { version: Schema.String },
  }),
  Rpc.make('GetServerVersion', {
    success: Schema.String,
  }),
).prefix('BotInfo/');
