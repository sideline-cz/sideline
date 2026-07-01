import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { OnboardingLocale, OnboardingSyncErrorCode } from '~/models/Onboarding.js';
import { TeamId } from '~/models/Team.js';
import {
  GuildNotFound,
  RsvpMemberNotFound,
  UpcomingEventsForUserResult,
} from '../event/EventRpcModels.js';

export const GuildRpcGroup = RpcGroup.make(
  Rpc.make('RegisterGuild', {
    payload: {
      guild_id: Discord.Snowflake,
      guild_name: Schema.String,
      // Tolerate missing key from pre-0.12.0 bot replicas during deploy windows.
      is_community_enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
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
  // Personal event channel provisioning RPCs
  Rpc.make('GetGuildsNeedingPersonalProvisioning', {
    payload: { limit: Schema.Number },
    success: Schema.Array(Discord.Snowflake),
  }),
  Rpc.make('GetPersonalEventsCategory', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('GetMembersNeedingPersonalChannel', {
    payload: { guild_id: Discord.Snowflake, limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        team_id: TeamId,
        team_member_id: Schema.String,
        discord_id: Discord.Snowflake,
        // Best-effort display name for the {name} channel-format placeholder.
        name: Schema.String,
        // The team's discord_personal_events_channel_format template.
        channel_format: Schema.String,
      }),
    ),
  }),
  // Members who currently have a personal channel but are no longer eligible
  // (excluded by the configured personal-events group). Used for de-provisioning.
  Rpc.make('GetPersonalChannelsToDeprovision', {
    payload: { guild_id: Discord.Snowflake, limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        team_id: TeamId,
        team_member_id: Schema.String,
        discord_channel_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('ReservePersonalChannel', {
    payload: { team_id: TeamId, team_member_id: Schema.String },
    success: Schema.Struct({ reserved: Schema.Boolean }),
  }),
  Rpc.make('SavePersonalChannelId', {
    payload: {
      team_id: TeamId,
      team_member_id: Schema.String,
      discord_channel_id: Discord.Snowflake,
      // The channel-name format applied when creating the channel.
      channel_format: Schema.String,
    },
  }),
  // Records the channel-name format last applied to a member's channel (after a
  // rename), so format-change drift can be detected.
  Rpc.make('SavePersonalChannelFormat', {
    payload: {
      team_id: TeamId,
      team_member_id: Schema.String,
      channel_format: Schema.String,
    },
  }),
  // Members whose personal channel name was rendered with a now-outdated format
  // (the team's channel-name format changed). Used to rename existing channels.
  Rpc.make('GetPersonalChannelsToRename', {
    payload: { guild_id: Discord.Snowflake, limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        team_id: TeamId,
        team_member_id: Schema.String,
        discord_id: Discord.Snowflake,
        discord_channel_id: Discord.Snowflake,
        name: Schema.String,
        channel_format: Schema.String,
      }),
    ),
  }),
  // Marks all of a team's active upcoming events dirty so the reconcile loop
  // backfills personal messages (e.g. into a freshly-provisioned channel).
  Rpc.make('MarkTeamPersonalEventsDirty', {
    payload: { team_id: TeamId },
  }),
  // Classifies a channel for the `/event refresh` command: the team's global events
  // channel, a member's personal events channel (with that member's identity), or
  // neither — plus whether the caller is a team admin (holds the `team:manage`
  // permission). The bot compares `owner_discord_id` to the caller to tell the
  // caller's own personal channel apart from another member's (admin-only).
  Rpc.make('IdentifyEventsChannel', {
    payload: {
      guild_id: Discord.Snowflake,
      channel_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: Schema.Struct({
      kind: Schema.Literals(['global', 'personal', 'none']),
      team_id: Schema.OptionFromNullOr(TeamId),
      team_member_id: Schema.OptionFromNullOr(Schema.String),
      owner_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
      is_admin: Schema.Boolean,
    }),
  }),
  // Resolves the caller's team membership and whether they hold the `team:manage`
  // permission (team admin) for the given guild. Used by the `/sudo` command to
  // authorize admin-only actions without requiring a specific channel context.
  Rpc.make('CheckTeamAdmin', {
    payload: { guild_id: Discord.Snowflake, discord_user_id: Discord.Snowflake },
    success: Schema.Struct({
      team_id: Schema.OptionFromNullOr(TeamId),
      is_admin: Schema.Boolean,
    }),
  }),
  // Begins (or restarts) a `/sudo` session for a caller in a guild: persists the
  // audit-message location + start time so the session can later be closed by
  // `EndSudoSession` (via the "leave sudo" button or by re-running `/sudo`).
  Rpc.make('BeginSudoSession', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      system_channel_id: Discord.Snowflake,
      audit_message_id: Discord.Snowflake,
      started_at: Schema.DateTimeUtc,
    },
    success: Schema.Struct({}),
  }),
  // Ends the caller's active `/sudo` session for a guild (if any), returning the
  // audit-message location + start time so the bot can close that message and
  // report the elapsed duration. Returns None if there was no active session.
  Rpc.make('EndSudoSession', {
    payload: { guild_id: Discord.Snowflake, discord_user_id: Discord.Snowflake },
    success: Schema.Struct({
      session: Schema.OptionFromNullOr(
        Schema.Struct({
          started_at: Schema.DateTimeUtc,
          system_channel_id: Discord.Snowflake,
          audit_message_id: Discord.Snowflake,
        }),
      ),
    }),
  }),
  Rpc.make('GetPersonalChannel', {
    payload: { team_id: TeamId, team_member_id: Schema.String },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('DeletePersonalChannel', {
    payload: { team_id: TeamId, team_member_id: Schema.String },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('ListPersonalChannelsForEvent', {
    payload: { event_id: Schema.String },
    success: Schema.Array(
      Schema.Struct({
        team_member_id: Schema.String,
        discord_id: Discord.Snowflake,
        personal_channel_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('GetPersonalChannelTargetCategory', {
    payload: { team_id: TeamId },
    success: Schema.Struct({
      category_id: Schema.OptionFromNullOr(Discord.Snowflake),
      is_overflow: Schema.Boolean,
    }),
  }),
  Rpc.make('AllocatePersonalOverflowCategory', {
    payload: { team_id: TeamId },
    success: Schema.Struct({ sequence: Schema.Int, exists: Schema.Boolean }),
  }),
  Rpc.make('SavePersonalOverflowCategoryId', {
    payload: {
      team_id: TeamId,
      sequence: Schema.Int,
      discord_category_id: Discord.Snowflake,
    },
  }),
  Rpc.make('ListPersonalOverflowCategories', {
    payload: { team_id: TeamId },
    success: Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        discord_category_id: Discord.Snowflake,
      }),
    ),
  }),
  // All upcoming events for a user — same result shape as GetUpcomingEventsForUser but without pagination
  Rpc.make('GetAllUpcomingEventsForUser', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: UpcomingEventsForUserResult,
    error: Schema.Union([GuildNotFound, RsvpMemberNotFound]),
  }),
).prefix('Guild/');
