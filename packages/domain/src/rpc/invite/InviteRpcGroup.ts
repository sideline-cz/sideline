import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { InviteGeneratorErrorCode } from '~/models/Onboarding.js';
import { TeamInviteId } from '~/models/TeamInvite.js';

export const InviteRpcGroup = RpcGroup.make(
  Rpc.make('PendingDiscordCodes', {
    payload: { limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        invite_id: TeamInviteId,
        guild_id: Discord.Snowflake,
        welcome_channel_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('SetDiscordCode', {
    payload: {
      invite_id: TeamInviteId,
      discord_code: Schema.String,
    },
  }),
  Rpc.make('MarkDiscordCodeFailed', {
    payload: {
      invite_id: TeamInviteId,
      error_code: InviteGeneratorErrorCode,
      error_detail: Schema.String,
    },
  }),
).prefix('Invite/');
