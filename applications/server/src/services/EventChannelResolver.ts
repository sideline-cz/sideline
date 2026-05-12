import type { Discord, Event, GroupModel, Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';

const eventTypeToSettingsField = (eventType: string) => {
  switch (eventType) {
    case 'training':
      return 'discord_channel_training' as const;
    case 'match':
      return 'discord_channel_match' as const;
    case 'tournament':
      return 'discord_channel_tournament' as const;
    case 'meeting':
      return 'discord_channel_meeting' as const;
    case 'social':
      return 'discord_channel_social' as const;
    default:
      return 'discord_channel_other' as const;
  }
};

export const resolveChannel = (
  teamId: Team.TeamId,
  eventId: Event.EventId,
): Effect.Effect<
  Option.Option<Discord.Snowflake>,
  never,
  | EventsRepository
  | TrainingTypesRepository
  | TeamSettingsRepository
  | DiscordChannelMappingRepository
> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('settings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('event', ({ events }) => events.findEventByIdWithDetails(eventId)),
    Effect.flatMap(({ event, trainingTypes, settings }) =>
      Option.match(event, {
        onNone: () => Effect.succeed(Option.none<Discord.Snowflake>()),
        onSome: (ev) => {
          // 1. Per-event override
          if (Option.isSome(ev.discord_target_channel_id))
            return Effect.succeed(ev.discord_target_channel_id);

          // 2. Training type default
          const trainingTypeCheck = Option.isSome(ev.training_type_id)
            ? trainingTypes
                .findTrainingTypeById(ev.training_type_id.value)
                .pipe(Effect.map((opt) => Option.flatMap(opt, (tt) => tt.discord_channel_id)))
            : Effect.succeed(Option.none<Discord.Snowflake>());

          return trainingTypeCheck.pipe(
            Effect.flatMap((channelFromTT) =>
              Option.isSome(channelFromTT)
                ? Effect.succeed(channelFromTT)
                : // 3. Team settings event-type default
                  settings
                    .findByTeamId(teamId)
                    .pipe(
                      Effect.map((opt) =>
                        Option.flatMap(opt, (s) => s[eventTypeToSettingsField(ev.event_type)]),
                      ),
                    ),
            ),
            // 4. Owner group channel fallback
            Effect.flatMap((channelFromSettings) =>
              Option.isSome(channelFromSettings)
                ? Effect.succeed(channelFromSettings)
                : resolveOwnerGroupChannel(teamId, ev.owner_group_id),
            ),
          );
        },
      }),
    ),
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
