import type { Discord, GroupModel, Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';

/**
 * Resolves the global events channel for a team.
 * Returns `team_settings.discord_events_channel_id`.
 */
export const resolveChannel = (
  teamId: Team.TeamId,
): Effect.Effect<Option.Option<Discord.Snowflake>, never, TeamSettingsRepository> =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.flatMap((settings) => settings.findByTeamId(teamId)),
    Effect.map(Option.flatMap((s) => s.discord_events_channel_id)),
  );

export const resolveOwnerGroupChannel = (
  teamId: Team.TeamId,
  ownerGroupId: Option.Option<GroupModel.GroupId>,
): Effect.Effect<Option.Option<Discord.Snowflake>, never, DiscordChannelMappingRepository> =>
  Option.match(ownerGroupId, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (groupId) =>
      DiscordChannelMappingRepository.asEffect().pipe(
        Effect.flatMap((mappings) => mappings.findByGroupId(teamId, groupId)),
        Effect.map((opt) => Option.flatMap(opt, (m) => m.discord_channel_id)),
      ),
  });

/**
 * Resolves the channel where reminder/start announcements are posted: explicit
 * reminders channel takes priority, falling back to the owner group's channel
 * mapping.
 */
export const resolveReminderChannel = (
  teamId: Team.TeamId,
  ownerGroupId: Option.Option<GroupModel.GroupId>,
  remindersChannelId: Option.Option<Discord.Snowflake>,
): Effect.Effect<Option.Option<Discord.Snowflake>, never, DiscordChannelMappingRepository> =>
  Option.match(remindersChannelId, {
    onSome: (id) => Effect.succeed(Option.some(id)),
    onNone: () => resolveOwnerGroupChannel(teamId, ownerGroupId),
  });

/**
 * Resolves the Discord role mapped to a member group, if any. Returns
 * `Option.none()` when the group is absent or has no mapping.
 */
export const resolveGroupRoleId = (
  teamId: Team.TeamId,
  memberGroupId: Option.Option<GroupModel.GroupId>,
): Effect.Effect<Option.Option<Discord.Snowflake>, never, DiscordChannelMappingRepository> =>
  Option.match(memberGroupId, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (groupId) =>
      DiscordChannelMappingRepository.asEffect().pipe(
        Effect.flatMap((mappings) => mappings.findByGroupId(teamId, groupId)),
        Effect.map(Option.flatMap((m) => m.discord_role_id)),
      ),
  });
