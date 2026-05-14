import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import {
  FinanceGuildNotFound,
  FinanceMemberNotFound,
  GetMyStatusResult,
} from './FinanceRpcModels.js';

export const FinanceRpcGroup = RpcGroup.make(
  Rpc.make('GetMyStatus', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: GetMyStatusResult,
    error: Schema.Union([FinanceGuildNotFound, FinanceMemberNotFound]),
  }),
).prefix('Finance/');
