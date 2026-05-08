import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';

export const GuildRpcGroup = RpcGroup.make(
  Rpc.make('RegisterGuild', {
    payload: { guild_id: Discord.Snowflake, guild_name: Schema.String },
  }),
  Rpc.make('UnregisterGuild', {
    payload: { guild_id: Discord.Snowflake },
  }),
  Rpc.make('IsGuildRegistered', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.Boolean,
  }),
  Rpc.make('SyncGuildChannels', {
    payload: {
      guild_id: Discord.Snowflake,
      channels: Schema.Array(
        Schema.Struct({
          channel_id: Discord.Snowflake,
          name: Schema.String,
          type: Schema.Number,
          parent_id: Schema.OptionFromNullOr(Discord.Snowflake),
        }),
      ),
    },
  }),
  Rpc.make('UpdateChannelName', {
    payload: {
      channel_id: Discord.Snowflake,
      name: Schema.String,
    },
  }),
  Rpc.make('UpsertChannel', {
    payload: {
      guild_id: Discord.Snowflake,
      channel_id: Discord.Snowflake,
      name: Schema.String,
      type: Schema.Number,
      parent_id: Schema.OptionFromNullOr(Discord.Snowflake),
    },
  }),
  Rpc.make('DeleteChannel', {
    payload: {
      guild_id: Discord.Snowflake,
      channel_id: Discord.Snowflake,
    },
  }),
  Rpc.make('ReconcileMembers', {
    payload: {
      guild_id: Discord.Snowflake,
      members: Schema.Array(
        Schema.Struct({
          discord_id: Schema.String,
          username: Schema.String,
          avatar: Schema.OptionFromNullOr(Schema.String),
          roles: Schema.Array(Schema.String),
          nickname: Schema.OptionFromNullOr(Schema.String),
          display_name: Schema.OptionFromNullOr(Schema.String),
        }),
      ),
    },
  }),
  Rpc.make('RegisterMember', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_id: Schema.String,
      username: Schema.String,
      avatar: Schema.OptionFromNullOr(Schema.String),
      roles: Schema.Array(Schema.String),
      nickname: Schema.OptionFromNullOr(Schema.String),
      display_name: Schema.OptionFromNullOr(Schema.String),
      invite_code: Schema.OptionFromNullOr(Schema.String),
    },
    success: Schema.OptionFromNullOr(
      Schema.Struct({
        system_log_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
        welcome: Schema.OptionFromNullOr(
          Schema.Struct({
            welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
            welcome_message_rendered: Schema.OptionFromNullOr(Schema.String),
            group_name: Schema.OptionFromNullOr(Schema.String),
            group_color_int: Schema.OptionFromNullOr(Schema.Number),
            inviter_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
          }),
        ),
        invite_code: Schema.OptionFromNullOr(Schema.String),
      }),
    ),
  }),
).prefix('Guild/');
