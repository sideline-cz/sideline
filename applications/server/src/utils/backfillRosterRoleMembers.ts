import type { Discord, Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import type { RosterMissingRoleRow } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { applyDiscordFormat, DEFAULT_ROLE_FORMAT } from '~/utils/applyDiscordFormat.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

const BACKFILL_LIMIT = 50;

const emitRosterRoleMemberBackfill = (row: RosterMissingRoleRow) =>
  Effect.Do.pipe(
    Effect.bind('teamSettingsRepo', () => TeamSettingsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('maybeSettings', ({ teamSettingsRepo }) =>
      teamSettingsRepo.findByTeamId(row.team_id),
    ),
    Effect.flatMap(({ maybeSettings, channelSync }) => {
      const roleName = applyDiscordFormat(
        Option.match(maybeSettings, {
          onNone: () => DEFAULT_ROLE_FORMAT,
          onSome: (s) => s.discord_role_format,
        }),
        row.name,
        row.emoji,
      );
      const discordRoleColor = Option.map(row.color, hexColorToDiscordInt);
      const targetCategoryId = Option.match(maybeSettings, {
        onNone: () => Option.none<Discord.Snowflake>(),
        onSome: (s) => s.discord_roster_category_id,
      });
      // Attach the role to the roster's existing channel (if any); never create a new channel.
      return channelSync.emitRosterChannelCreated(
        row.team_id,
        row.roster_id,
        row.name,
        row.discord_channel_id,
        undefined,
        roleName,
        discordRoleColor,
        targetCategoryId,
      );
    }),
  );

export const backfillRosterRoleMembers = (teamId: Team.TeamId) =>
  Effect.Do.pipe(
    Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.bind('count', ({ channelMappings }) =>
      channelMappings.countActiveRostersWithRole(teamId),
    ),
    Effect.bind('rows', ({ channelMappings }) =>
      channelMappings.findActiveRostersWithRole(teamId, BACKFILL_LIMIT),
    ),
    Effect.tap(({ rows }) =>
      Effect.forEach(rows, emitRosterRoleMemberBackfill, { concurrency: 1 }),
    ),
    Effect.let('processedCount', ({ rows }) => rows.length),
    Effect.let('remainingCount', ({ count, processedCount }) =>
      Math.max(0, count - processedCount),
    ),
    Effect.tap(({ processedCount, remainingCount }) =>
      Effect.logInfo(
        `Roster role backfill: processed=${processedCount}, remaining=${remainingCount}`,
      ),
    ),
    Effect.map(({ processedCount, remainingCount }) => ({ processedCount, remainingCount })),
  );
