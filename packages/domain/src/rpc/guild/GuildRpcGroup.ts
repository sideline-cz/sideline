import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { OnboardingLocale, OnboardingSyncErrorCode } from '~/models/Onboarding.js';
import { TeamId } from '~/models/Team.js';

export const GuildRpcGroup = RpcGroup.make(
  Rpc.make('RegisterGuild', {
    payload: {
      guild_id: Discord.Snowflake,
      guild_name: Schema.String,
      is_community_enabled: Schema.Boolean,
    },
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
  Rpc.make('PendingGuildJoins', {
    success: Schema.Array(
      Schema.Struct({
        id: Schema.String.pipe(Schema.check(Schema.isUUID())),
        guild_id: Discord.Snowflake,
        discord_id: Schema.String,
        access_token: Schema.String,
      }),
    ),
  }),
  Rpc.make('MarkGuildJoinDone', {
    payload: { id: Schema.String.pipe(Schema.check(Schema.isUUID())) },
  }),
  Rpc.make('MarkGuildJoinFailed', {
    payload: { id: Schema.String.pipe(Schema.check(Schema.isUUID())), error: Schema.String },
  }),
  Rpc.make('PendingOnboardingSyncs', {
    payload: { limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        team_id: TeamId,
        guild_id: Discord.Snowflake,
        team_name: Schema.String,
        onboarding_locale: OnboardingLocale,
        rules_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
        welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
        training_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
        onboarding_rules_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
        onboarding_rules_prompt_id: Schema.OptionFromNullOr(Discord.Snowflake),
        is_community_enabled: Schema.Boolean,
      }),
    ),
  }),
  Rpc.make('MarkOnboardingSyncDone', {
    payload: {
      team_id: TeamId,
      prompt_id: Schema.OptionFromNullOr(Discord.Snowflake),
    },
    success: Schema.Struct({ updated: Schema.Boolean }),
  }),
  Rpc.make('MarkOnboardingSyncFailed', {
    payload: {
      team_id: TeamId,
      error_code: OnboardingSyncErrorCode,
      error_detail: Schema.String,
    },
    success: Schema.Struct({ updated: Schema.Boolean }),
  }),
  Rpc.make('RevertOnboardingSync', {
    payload: { team_id: TeamId },
  }),
  Rpc.make('MarkOnboardingSyncSkipped', {
    payload: { team_id: TeamId },
  }),
  Rpc.make('GetOnboardingRulesRoleId', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('SyncCommunityFlags', {
    payload: {
      guilds: Schema.Array(
        Schema.Struct({
          guild_id: Discord.Snowflake,
          is_community_enabled: Schema.Boolean,
        }),
      ),
    },
  }),
  Rpc.make('ListGuildRoles', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.Array(
      Schema.Struct({
        id: Discord.Snowflake,
        name: Schema.String,
        color: Schema.Number,
        position: Schema.Number,
        managed: Schema.Boolean,
      }),
    ),
  }),
  Rpc.make('SyncGuildRoles', {
    payload: {
      guild_id: Discord.Snowflake,
      roles: Schema.Array(
        Schema.Struct({
          role_id: Discord.Snowflake,
          name: Schema.String,
          color: Schema.Number,
          position: Schema.Number,
          managed: Schema.Boolean,
        }),
      ),
    },
  }),
  Rpc.make('UpsertGuildRole', {
    payload: {
      guild_id: Discord.Snowflake,
      role_id: Discord.Snowflake,
      name: Schema.String,
      color: Schema.Number,
      position: Schema.Number,
      managed: Schema.Boolean,
    },
  }),
  Rpc.make('DeleteGuildRole', {
    payload: {
      guild_id: Discord.Snowflake,
      role_id: Discord.Snowflake,
    },
  }),
).prefix('Guild/');
