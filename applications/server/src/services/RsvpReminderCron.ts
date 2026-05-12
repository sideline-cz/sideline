import { Array, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { resolveReminderChannel } from '~/services/EventChannelResolver.js';

export const rsvpReminderCronEffect = Effect.Do.pipe(
  Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
  Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
  Effect.bind('syncRepo', () => EventSyncEventsRepository.asEffect()),
  Effect.bind('mappingRepo', () => DiscordChannelMappingRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('RsvpReminderCron: starting reminder cycle')),
  Effect.bind('events', ({ settingsRepo }) => settingsRepo.findEventsNeedingReminder()),
  Effect.tap(({ events, syncRepo, eventsRepo, mappingRepo }) =>
    Effect.all(
      Array.map(events, (event) =>
        Effect.Do.pipe(
          Effect.bind('discordRoleId', () =>
            Option.match(event.member_group_id, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (groupId) =>
                mappingRepo
                  .findByGroupId(event.team_id, groupId)
                  .pipe(Effect.map(Option.flatMap((m) => m.discord_role_id))),
            }),
          ),
          Effect.bind('channel', () =>
            resolveReminderChannel(event.team_id, event.owner_group_id, event.reminders_channel_id),
          ),
          Effect.flatMap(({ discordRoleId, channel }) =>
            syncRepo.emitRsvpReminder(
              event.team_id,
              event.event_id,
              event.title,
              Option.none(),
              event.start_at,
              Option.none(),
              Option.none(),
              event.event_type,
              channel,
              event.member_group_id,
              discordRoleId,
            ),
          ),
          Effect.tap(() => eventsRepo.markReminderSent(event.event_id)),
          Effect.tap(() =>
            Effect.logInfo(
              `RsvpReminderCron: queued reminder for event "${event.title}" (${event.event_id})`,
            ),
          ),
          Effect.tap(() =>
            event.event_type === 'training' && Option.isNone(event.claimed_by)
              ? Option.match(event.owner_group_id, {
                  onNone: () => Effect.void,
                  onSome: (ownerGroupId) =>
                    mappingRepo.findByGroupId(event.team_id, ownerGroupId).pipe(
                      Effect.flatMap((mapping) =>
                        Option.match(mapping, {
                          onNone: () =>
                            Effect.logWarning(
                              `RsvpReminderCron: no owner channel for unclaimed training ${event.event_id}, skipping unclaimed reminder`,
                            ),
                          onSome: (m) =>
                            Option.match(m.discord_channel_id, {
                              onNone: () => Effect.void,
                              onSome: (channelId) =>
                                syncRepo.emitUnclaimedTrainingReminder(
                                  event.team_id,
                                  event.event_id,
                                  event.title,
                                  event.start_at,
                                  Option.none(),
                                  Option.none(),
                                  channelId,
                                  m.discord_role_id,
                                  event.claim_discord_channel_id,
                                  event.claim_discord_message_id,
                                ),
                            }),
                        }),
                      ),
                      Effect.tapDefect((e) =>
                        Effect.logWarning(
                          `RsvpReminderCron: failed to emit unclaimed training reminder for event ${event.event_id}`,
                          e,
                        ),
                      ),
                      Effect.catchDefect(() => Effect.void),
                    ),
                })
              : Effect.void,
          ),
        ).pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`RsvpReminderCron: failed for event ${event.event_id}`, e),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ events }) =>
    Effect.logInfo(`RsvpReminderCron: cycle complete, ${String(events.length)} event(s) processed`),
  ),
  Effect.asVoid,
  withCronMetrics('rsvp-reminder'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const RsvpReminderCron = rsvpReminderCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
