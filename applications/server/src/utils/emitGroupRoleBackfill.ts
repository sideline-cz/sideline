import { Effect, Option } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import type { GroupMissingRoleRow } from '~/repositories/DiscordChannelMappingRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import {
  applyDiscordFormat,
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

/**
 * For a group that is missing its Discord role, enqueue a provisioning event.
 * Computes the channel/role name and color from the team's settings, then routes
 * to either an existing-channel attach (group already has a `discord_channel_id`)
 * or a new-channel create (gated by the team's `create_discord_channel_on_group`).
 */
export const emitMissingGroupRoleProvision = (group: GroupMissingRoleRow) =>
  Effect.Do.pipe(
    Effect.bind('teamSettingsRepo', () => TeamSettingsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('maybeSettings', ({ teamSettingsRepo }) =>
      teamSettingsRepo.findByTeamId(group.team_id),
    ),
    Effect.flatMap(({ maybeSettings, channelSync }) => {
      const channelName = applyDiscordFormat(
        Option.match(maybeSettings, {
          onNone: () => DEFAULT_CHANNEL_FORMAT,
          onSome: (s) => s.discord_channel_format,
        }),
        group.name,
        group.emoji,
      );
      const roleName = applyDiscordFormat(
        Option.match(maybeSettings, {
          onNone: () => DEFAULT_ROLE_FORMAT,
          onSome: (s) => s.discord_role_format,
        }),
        group.name,
        group.emoji,
      );
      const discordRoleColor = Option.map(group.color, hexColorToDiscordInt);
      const createChannel = Option.match(maybeSettings, {
        onNone: () => true,
        onSome: (s) => s.create_discord_channel_on_group,
      });
      return Option.match(group.discord_channel_id, {
        onSome: (existingChannelId) =>
          // Group already has a channel — attach role to it, no new channel
          channelSync.emitChannelCreated(
            group.team_id,
            group.group_id,
            group.name,
            Option.some(existingChannelId),
            undefined,
            roleName,
            discordRoleColor,
          ),
        onNone: () =>
          // No existing channel — create one if team setting allows it
          channelSync.emitChannelCreated(
            group.team_id,
            group.group_id,
            group.name,
            Option.none(),
            createChannel ? channelName : undefined,
            roleName,
            discordRoleColor,
          ),
      });
    }),
  );
