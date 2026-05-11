import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { InviteAcceptanceId } from '~/models/InviteAcceptance.js';
import { InviteGeneratorErrorCode } from '~/models/Onboarding.js';

export const InviteRpcGroup = RpcGroup.make(
  Rpc.make('PendingAcceptances', {
    payload: { limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        acceptance_id: InviteAcceptanceId,
        guild_id: Discord.Snowflake,
        welcome_channel_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('SetAcceptanceDiscordCode', {
    payload: {
      acceptance_id: InviteAcceptanceId,
      discord_code: Schema.String,
    },
  }),
  Rpc.make('MarkAcceptanceFailed', {
    payload: {
      acceptance_id: InviteAcceptanceId,
      error_code: InviteGeneratorErrorCode,
      error_detail: Schema.String,
    },
  }),
).prefix('Invite/');
