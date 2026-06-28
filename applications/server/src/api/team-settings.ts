import { Auth, EventApi, TeamSettingsApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { DEFAULT_CHANNEL_FORMAT, DEFAULT_ROLE_FORMAT } from '~/utils/applyDiscordFormat.js';

const forbidden = new EventApi.Forbidden();

export const TeamSettingsApiLive = HttpApiBuilder.group(Api, 'teamSettings', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('settings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.map(({ members, settings, teams }) =>
      handlers
        .handle('getTeamSettings', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('row', () => settings.findByTeamId(teamId)),
            Effect.map(({ row }) =>
              Option.match(row, {
                onNone: () =>
                  new TeamSettingsApi.TeamSettingsInfo({
                    teamId,
                    eventHorizonDays: 30,
                    minPlayersThreshold: 0,
                    rsvpRemindersEnabled: true,
                    rsvpReminderDaysBefore: 1,
                    claimRequestDaysBefore: 3,
                    rsvpReminderTime: '18:00',
                    remindersChannelId: Option.none(),
                    timezone: 'Europe/Prague',
                    discordChannelTraining: Option.none(),
                    discordChannelMatch: Option.none(),
                    discordChannelTournament: Option.none(),
                    discordChannelMeeting: Option.none(),
                    discordChannelSocial: Option.none(),
                    discordChannelOther: Option.none(),
                    discordChannelLateRsvp: Option.none(),
                    createDiscordChannelOnGroup: true,
                    createDiscordChannelOnRoster: true,
                    discordArchiveCategoryId: Option.none(),
                    discordRosterCategoryId: Option.none(),
                    discordChannelCleanupOnGroupDelete: 'delete',
                    discordChannelCleanupOnRosterDeactivate: 'delete',
                    discordRoleFormat: DEFAULT_ROLE_FORMAT,
                    discordChannelFormat: DEFAULT_CHANNEL_FORMAT,
                    maxMissedRsvps: 4,
                  }),
                onSome: (s) =>
                  new TeamSettingsApi.TeamSettingsInfo({
                    teamId,
                    eventHorizonDays: s.event_horizon_days,
                    minPlayersThreshold: s.min_players_threshold,
                    rsvpRemindersEnabled: s.rsvp_reminders_enabled,
                    rsvpReminderDaysBefore: s.rsvp_reminder_days_before,
                    claimRequestDaysBefore: s.claim_request_days_before,
                    rsvpReminderTime: s.rsvp_reminder_time,
                    remindersChannelId: s.reminders_channel_id,
                    timezone: s.timezone,
                    discordChannelTraining: s.discord_channel_training,
                    discordChannelMatch: s.discord_channel_match,
                    discordChannelTournament: s.discord_channel_tournament,
                    discordChannelMeeting: s.discord_channel_meeting,
                    discordChannelSocial: s.discord_channel_social,
                    discordChannelOther: s.discord_channel_other,
                    discordChannelLateRsvp: s.discord_channel_late_rsvp,
                    createDiscordChannelOnGroup: s.create_discord_channel_on_group,
                    createDiscordChannelOnRoster: s.create_discord_channel_on_roster,
                    discordArchiveCategoryId: s.discord_archive_category_id,
                    discordRosterCategoryId: s.discord_roster_category_id,
                    discordChannelCleanupOnGroupDelete: s.discord_channel_cleanup_on_group_delete,
                    discordChannelCleanupOnRosterDeactivate:
                      s.discord_channel_cleanup_on_roster_deactivate,
                    discordRoleFormat: s.discord_role_format,
                    discordChannelFormat: s.discord_channel_format,
                    maxMissedRsvps: s.max_missed_rsvps,
                  }),
              }),
            ),
          ),
        )
        .handle('updateTeamSettings', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('existing', () => settings.findByTeamId(teamId)),
            Effect.let('prevTrainingChannel', ({ existing }) =>
              Option.match(existing, {
                onNone: () => Option.none<string>(),
                onSome: (s) => s.discord_channel_training,
              }),
            ),
            Effect.let('nextTrainingChannel', ({ existing }) =>
              Option.match(payload.discordChannelTraining, {
                onNone: () =>
                  Option.match(existing, {
                    onNone: () => Option.none<string>(),
                    onSome: (s) => s.discord_channel_training,
                  }),
                onSome: (v) => v,
              }),
            ),
            Effect.bind('result', ({ existing }) =>
              Option.match(existing, {
                onNone: () =>
                  settings.upsert({
                    teamId,
                    eventHorizonDays: Option.getOrElse(payload.eventHorizonDays, () => 30),
                    minPlayersThreshold: Option.getOrElse(payload.minPlayersThreshold, () => 0),
                    rsvpRemindersEnabled: Option.getOrElse(
                      payload.rsvpRemindersEnabled,
                      () => true,
                    ),
                    rsvpReminderDaysBefore: Option.getOrElse(
                      payload.rsvpReminderDaysBefore,
                      () => 1,
                    ),
                    claimRequestDaysBefore: Option.getOrElse(
                      payload.claimRequestDaysBefore,
                      () => 3,
                    ),
                    rsvpReminderTime: Option.getOrElse(payload.rsvpReminderTime, () => '18:00'),
                    remindersChannelId: Option.flatten(payload.remindersChannelId),
                    timezone: Option.getOrElse(payload.timezone, () => 'Europe/Prague'),
                    discordChannelTraining: Option.flatten(payload.discordChannelTraining),
                    discordChannelMatch: Option.flatten(payload.discordChannelMatch),
                    discordChannelTournament: Option.flatten(payload.discordChannelTournament),
                    discordChannelMeeting: Option.flatten(payload.discordChannelMeeting),
                    discordChannelSocial: Option.flatten(payload.discordChannelSocial),
                    discordChannelOther: Option.flatten(payload.discordChannelOther),
                    discordChannelLateRsvp: Option.flatten(payload.discordChannelLateRsvp),
                    createDiscordChannelOnGroup: Option.getOrElse(
                      payload.createDiscordChannelOnGroup,
                      () => true,
                    ),
                    createDiscordChannelOnRoster: Option.getOrElse(
                      payload.createDiscordChannelOnRoster,
                      () => true,
                    ),
                    discordArchiveCategoryId: Option.flatten(payload.discordArchiveCategoryId),
                    discordRosterCategoryId: Option.flatten(payload.discordRosterCategoryId),
                    discordChannelCleanupOnGroupDelete: Option.getOrElse(
                      payload.discordChannelCleanupOnGroupDelete,
                      () => 'delete' as const,
                    ),
                    discordChannelCleanupOnRosterDeactivate: Option.getOrElse(
                      payload.discordChannelCleanupOnRosterDeactivate,
                      () => 'delete' as const,
                    ),
                    ...(Option.isSome(payload.discordRoleFormat)
                      ? { discordRoleFormat: payload.discordRoleFormat.value }
                      : {}),
                    ...(Option.isSome(payload.discordChannelFormat)
                      ? { discordChannelFormat: payload.discordChannelFormat.value }
                      : {}),
                    maxMissedRsvps: Option.getOrElse(payload.maxMissedRsvps, () => 4),
                  }),
                onSome: (s) =>
                  settings.upsert({
                    teamId,
                    eventHorizonDays: Option.getOrElse(
                      payload.eventHorizonDays,
                      () => s.event_horizon_days,
                    ),
                    minPlayersThreshold: Option.getOrElse(
                      payload.minPlayersThreshold,
                      () => s.min_players_threshold,
                    ),
                    rsvpRemindersEnabled: Option.getOrElse(
                      payload.rsvpRemindersEnabled,
                      () => s.rsvp_reminders_enabled,
                    ),
                    rsvpReminderDaysBefore: Option.getOrElse(
                      payload.rsvpReminderDaysBefore,
                      () => s.rsvp_reminder_days_before,
                    ),
                    claimRequestDaysBefore: Option.getOrElse(
                      payload.claimRequestDaysBefore,
                      () => s.claim_request_days_before,
                    ),
                    rsvpReminderTime: Option.getOrElse(
                      payload.rsvpReminderTime,
                      () => s.rsvp_reminder_time,
                    ),
                    remindersChannelId: Option.match(payload.remindersChannelId, {
                      onNone: () => s.reminders_channel_id,
                      onSome: (v) => v,
                    }),
                    timezone: Option.getOrElse(payload.timezone, () => s.timezone),
                    discordChannelTraining: Option.match(payload.discordChannelTraining, {
                      onNone: () => s.discord_channel_training,
                      onSome: (v) => v,
                    }),
                    discordChannelMatch: Option.match(payload.discordChannelMatch, {
                      onNone: () => s.discord_channel_match,
                      onSome: (v) => v,
                    }),
                    discordChannelTournament: Option.match(payload.discordChannelTournament, {
                      onNone: () => s.discord_channel_tournament,
                      onSome: (v) => v,
                    }),
                    discordChannelMeeting: Option.match(payload.discordChannelMeeting, {
                      onNone: () => s.discord_channel_meeting,
                      onSome: (v) => v,
                    }),
                    discordChannelSocial: Option.match(payload.discordChannelSocial, {
                      onNone: () => s.discord_channel_social,
                      onSome: (v) => v,
                    }),
                    discordChannelOther: Option.match(payload.discordChannelOther, {
                      onNone: () => s.discord_channel_other,
                      onSome: (v) => v,
                    }),
                    discordChannelLateRsvp: Option.match(payload.discordChannelLateRsvp, {
                      onNone: () => s.discord_channel_late_rsvp,
                      onSome: (v) => v,
                    }),
                    createDiscordChannelOnGroup: Option.getOrElse(
                      payload.createDiscordChannelOnGroup,
                      () => s.create_discord_channel_on_group,
                    ),
                    createDiscordChannelOnRoster: Option.getOrElse(
                      payload.createDiscordChannelOnRoster,
                      () => s.create_discord_channel_on_roster,
                    ),
                    discordArchiveCategoryId: Option.match(payload.discordArchiveCategoryId, {
                      onNone: () => s.discord_archive_category_id,
                      onSome: (v) => v,
                    }),
                    discordRosterCategoryId: Option.getOrElse(
                      payload.discordRosterCategoryId,
                      () => s.discord_roster_category_id,
                    ),
                    discordChannelCleanupOnGroupDelete: Option.getOrElse(
                      payload.discordChannelCleanupOnGroupDelete,
                      () => s.discord_channel_cleanup_on_group_delete,
                    ),
                    discordChannelCleanupOnRosterDeactivate: Option.getOrElse(
                      payload.discordChannelCleanupOnRosterDeactivate,
                      () => s.discord_channel_cleanup_on_roster_deactivate,
                    ),
                    discordRoleFormat: Option.getOrElse(
                      payload.discordRoleFormat,
                      () => s.discord_role_format,
                    ),
                    discordChannelFormat: Option.getOrElse(
                      payload.discordChannelFormat,
                      () => s.discord_channel_format,
                    ),
                    maxMissedRsvps: Option.getOrElse(
                      payload.maxMissedRsvps,
                      () => s.max_missed_rsvps,
                    ),
                  }),
              }),
            ),
            Effect.tap(({ prevTrainingChannel, nextTrainingChannel }) => {
              if (Option.getOrNull(prevTrainingChannel) !== Option.getOrNull(nextTrainingChannel)) {
                return teams.markOnboardingSyncPending(teamId);
              }
              return Effect.void;
            }),
            Effect.map(
              ({ result }) =>
                new TeamSettingsApi.TeamSettingsInfo({
                  teamId: result.team_id,
                  eventHorizonDays: result.event_horizon_days,
                  minPlayersThreshold: result.min_players_threshold,
                  rsvpRemindersEnabled: result.rsvp_reminders_enabled,
                  rsvpReminderDaysBefore: result.rsvp_reminder_days_before,
                  claimRequestDaysBefore: result.claim_request_days_before,
                  rsvpReminderTime: result.rsvp_reminder_time,
                  remindersChannelId: result.reminders_channel_id,
                  timezone: result.timezone,
                  discordChannelTraining: result.discord_channel_training,
                  discordChannelMatch: result.discord_channel_match,
                  discordChannelTournament: result.discord_channel_tournament,
                  discordChannelMeeting: result.discord_channel_meeting,
                  discordChannelSocial: result.discord_channel_social,
                  discordChannelOther: result.discord_channel_other,
                  discordChannelLateRsvp: result.discord_channel_late_rsvp,
                  createDiscordChannelOnGroup: result.create_discord_channel_on_group,
                  createDiscordChannelOnRoster: result.create_discord_channel_on_roster,
                  discordArchiveCategoryId: result.discord_archive_category_id,
                  discordRosterCategoryId: result.discord_roster_category_id,
                  discordChannelCleanupOnGroupDelete:
                    result.discord_channel_cleanup_on_group_delete,
                  discordChannelCleanupOnRosterDeactivate:
                    result.discord_channel_cleanup_on_roster_deactivate,
                  discordRoleFormat: result.discord_role_format,
                  discordChannelFormat: result.discord_channel_format,
                  maxMissedRsvps: result.max_missed_rsvps,
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed upserting team settings — no row returned'),
            ),
          ),
        ),
    ),
  ),
);
