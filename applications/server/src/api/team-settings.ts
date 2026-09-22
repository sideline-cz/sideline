import { Auth, EventApi, TeamSettingsApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import {
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';

const forbidden = new EventApi.Forbidden();

export const TeamSettingsApiLive = HttpApiBuilder.group(Api, 'teamSettings', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('settings', () => TeamSettingsRepository.asEffect()),
    Effect.map(({ members, settings }) =>
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
                    discordChannelLateRsvp: Option.none(),
                    createDiscordChannelOnGroup: true,
                    createDiscordChannelOnRoster: true,
                    discordArchiveCategoryId: Option.none(),
                    discordRosterCategoryId: Option.none(),
                    discordChannelCleanupOnGroupDelete: 'delete',
                    discordChannelCleanupOnRosterDeactivate: 'delete',
                    discordRoleFormat: DEFAULT_ROLE_FORMAT,
                    discordChannelFormat: DEFAULT_CHANNEL_FORMAT,
                    rulesQuizChannelId: Option.none(),
                    rulesQuizIntervalDays: 7,
                    rulesQuizTime: '18:00',
                    maxMissedRsvps: 4,
                    discordPersonalEventsCategoryId: Option.none(),
                    discordPersonalEventsGroupId: Option.none(),
                    discordPersonalEventsChannelFormat: DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
                    discordEventsChannelId: Option.none(),
                    requireCompleteProfile: false,
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
                    rulesQuizChannelId: s.rules_quiz_channel_id,
                    rulesQuizIntervalDays: s.rules_quiz_interval_days,
                    rulesQuizTime: s.rules_quiz_time,
                    maxMissedRsvps: s.max_missed_rsvps,
                    discordPersonalEventsCategoryId: s.discord_personal_events_category_id,
                    discordPersonalEventsGroupId: s.discord_personal_events_group_id,
                    discordPersonalEventsChannelFormat: s.discord_personal_events_channel_format,
                    discordEventsChannelId: s.discord_events_channel_id,
                    requireCompleteProfile: s.require_complete_profile,
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
            // The team's OLD timezone, before this save — needed to re-anchor
            // all-day events if the timezone is changing (plan §12 step 5).
            // For a team's FIRST settings row (`onNone` below) there is no
            // previous row to read, so the implicit old value is the column
            // default (§12 step 5c).
            Effect.let('oldTz', ({ existing }) =>
              Option.match(existing, {
                onNone: () => 'Europe/Prague',
                onSome: (s) => s.timezone,
              }),
            ),
            Effect.bind('result', ({ existing, oldTz }) =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql
                    .withTransaction(
                      Option.match(existing, {
                        onNone: () =>
                          settings.upsert({
                            teamId,
                            eventHorizonDays: Option.getOrElse(payload.eventHorizonDays, () => 30),
                            minPlayersThreshold: Option.getOrElse(
                              payload.minPlayersThreshold,
                              () => 0,
                            ),
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
                            rsvpReminderTime: Option.getOrElse(
                              payload.rsvpReminderTime,
                              () => '18:00',
                            ),
                            remindersChannelId: Option.flatten(payload.remindersChannelId),
                            timezone: Option.getOrElse(payload.timezone, () => 'Europe/Prague'),
                            discordChannelLateRsvp: Option.flatten(payload.discordChannelLateRsvp),
                            createDiscordChannelOnGroup: Option.getOrElse(
                              payload.createDiscordChannelOnGroup,
                              () => true,
                            ),
                            createDiscordChannelOnRoster: Option.getOrElse(
                              payload.createDiscordChannelOnRoster,
                              () => true,
                            ),
                            discordArchiveCategoryId: Option.flatten(
                              payload.discordArchiveCategoryId,
                            ),
                            discordRosterCategoryId: Option.flatten(
                              payload.discordRosterCategoryId,
                            ),
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
                            rulesQuizChannelId: Option.flatten(payload.rulesQuizChannelId),
                            rulesQuizIntervalDays: Option.getOrElse(
                              payload.rulesQuizIntervalDays,
                              () => 7,
                            ),
                            rulesQuizTime: Option.getOrElse(payload.rulesQuizTime, () => '18:00'),
                            discordPersonalEventsCategoryId: Option.flatten(
                              payload.discordPersonalEventsCategoryId,
                            ),
                            discordPersonalEventsGroupId: Option.flatten(
                              payload.discordPersonalEventsGroupId,
                            ),
                            discordPersonalEventsChannelFormat: Option.getOrElse(
                              payload.discordPersonalEventsChannelFormat,
                              () => DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
                            ),
                            // Transitional: kept only so the full-row upsert doesn't NULL this column;
                            // removed in Release B together with the column itself.
                            discordEventsChannelId: Option.flatten(payload.discordEventsChannelId),
                            requireCompleteProfile: Option.getOrElse(
                              payload.requireCompleteProfile,
                              () => false,
                            ),
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
                            discordArchiveCategoryId: Option.match(
                              payload.discordArchiveCategoryId,
                              {
                                onNone: () => s.discord_archive_category_id,
                                onSome: (v) => v,
                              },
                            ),
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
                            rulesQuizChannelId: Option.match(payload.rulesQuizChannelId, {
                              onNone: () => s.rules_quiz_channel_id,
                              onSome: (v) => v,
                            }),
                            rulesQuizIntervalDays: Option.getOrElse(
                              payload.rulesQuizIntervalDays,
                              () => s.rules_quiz_interval_days,
                            ),
                            rulesQuizTime: Option.getOrElse(
                              payload.rulesQuizTime,
                              () => s.rules_quiz_time,
                            ),
                            discordPersonalEventsCategoryId: Option.match(
                              payload.discordPersonalEventsCategoryId,
                              {
                                onNone: () => s.discord_personal_events_category_id,
                                onSome: (v) => v,
                              },
                            ),
                            discordPersonalEventsGroupId: Option.match(
                              payload.discordPersonalEventsGroupId,
                              {
                                onNone: () => s.discord_personal_events_group_id,
                                onSome: (v) => v,
                              },
                            ),
                            discordPersonalEventsChannelFormat: Option.getOrElse(
                              payload.discordPersonalEventsChannelFormat,
                              () => s.discord_personal_events_channel_format,
                            ),
                            // Transitional: kept only so the full-row upsert doesn't NULL this column;
                            // removed in Release B together with the column itself.
                            discordEventsChannelId: Option.match(payload.discordEventsChannelId, {
                              onNone: () => s.discord_events_channel_id,
                              onSome: (v) => v,
                            }),
                            requireCompleteProfile: Option.getOrElse(
                              payload.requireCompleteProfile,
                              () => s.require_complete_profile,
                            ),
                          }),
                      }).pipe(
                        // Timezone change re-anchors this team's all-day events —
                        // gated on `oldTz <> newTz` so an unrelated settings save does
                        // not take row locks on every all-day event of the team (plan
                        // §12 step 5a), and on `all_day_anchored` so a pre-PR-3
                        // noon-UTC sentinel (not yet an anchored instant) is never
                        // re-anchored by this formula — that would lose a day
                        // permanently (plan §12 step 5d, the blocker-level guard).
                        Effect.tap((upserted) =>
                          oldTz === upserted.timezone
                            ? Effect.void
                            : sql`
                        UPDATE events SET
                          start_at = date_trunc('day', start_at AT TIME ZONE ${oldTz})
                                       AT TIME ZONE ${upserted.timezone},
                          end_at   = CASE WHEN end_at IS NULL THEN NULL
                                          ELSE date_trunc('day', end_at AT TIME ZONE ${oldTz})
                                                 AT TIME ZONE ${upserted.timezone} END,
                          personal_messages_dirty_at = CASE
                            WHEN personal_messages_dirty_at IS NULL
                            THEN date_trunc('milliseconds', now())
                            ELSE personal_messages_dirty_at END
                        WHERE team_id = ${teamId} AND all_day = TRUE AND all_day_anchored
                      `.pipe(Effect.asVoid),
                        ),
                        // Timezone change also strands not-yet-materialized series
                        // occurrences already in `events`: for a TEAM-LOCAL (`times_are_
                        // team_local`) series, `event_series.start_time`/`end_time` are a
                        // wall clock, so a future, active, not-hand-edited occurrence must be
                        // re-derived from the (unchanged) series wall-clock time, re-anchored
                        // on its OLD-timezone calendar date but resolved in the NEW timezone —
                        // otherwise already-materialized events keep the old instant while the
                        // series regenerates new ones in the new zone, splitting the team's
                        // calendar in two. Structurally the same recomputation as the
                        // conversion migration's Statement B (`1792100000`, Release N+1, now
                        // shipped), run here instead of waiting for an operator to re-run a
                        // migration for every timezone edit.
                        //
                        // A FALSE (UTC-dialect, pre-#650) series stores an absolute UTC
                        // time-of-day, so a team timezone change is a no-op for it — exactly
                        // as it was before #650 — hence `AND es.times_are_team_local`
                        // (Release N, `.work-plans/series-time-conversion.md`
                        // §N.2 item 5).
                        //
                        // Why this date expression differs from the migration's: we only ever
                        // see already-team-local events (the `es.times_are_team_local` guard
                        // below), so we recover the occurrence date in the OLD team zone
                        // (`(e.start_at AT TIME ZONE oldTz)::date`); the migration's Statement B
                        // only ever sees UTC-dialect events, so it recovers the date in UTC
                        // instead. Same rule, disjoint populations — see
                        // `applications/server/AGENTS.md` rule 5. Do not align the two.
                        //
                        // Guards otherwise mirror Statement B's exactly: `series_id IS NOT
                        // NULL` (only series-generated events have one — the join to
                        // `event_series` below encodes this), `NOT series_modified`
                        // (never clobber a captain's per-occurrence override),
                        // `status = 'active'` (leave cancelled/started events alone),
                        // `start_at >= now()` (leave the past alone).
                        Effect.tap((upserted) =>
                          oldTz === upserted.timezone
                            ? Effect.void
                            : sql`
                        UPDATE events e
                        SET start_at = ((e.start_at AT TIME ZONE ${oldTz})::date + es.start_time)
                                         AT TIME ZONE ${upserted.timezone},
                            end_at   = CASE WHEN es.end_time IS NULL THEN NULL
                                            ELSE ((e.end_at AT TIME ZONE ${oldTz})::date + es.end_time)
                                                   AT TIME ZONE ${upserted.timezone} END,
                            personal_messages_dirty_at = CASE
                              WHEN e.personal_messages_dirty_at IS NULL
                              THEN date_trunc('milliseconds', now())
                              ELSE e.personal_messages_dirty_at END
                        FROM event_series es
                        WHERE e.series_id = es.id
                          AND e.team_id = ${teamId}
                          AND NOT e.series_modified
                          AND e.status = 'active'
                          AND e.start_at >= now()
                          AND es.times_are_team_local
                      `.pipe(Effect.asVoid),
                        ),
                      ),
                    )
                    .pipe(catchSqlErrors),
                ),
              ),
            ),
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
                  rulesQuizChannelId: result.rules_quiz_channel_id,
                  rulesQuizIntervalDays: result.rules_quiz_interval_days,
                  rulesQuizTime: result.rules_quiz_time,
                  maxMissedRsvps: result.max_missed_rsvps,
                  discordPersonalEventsCategoryId: result.discord_personal_events_category_id,
                  discordPersonalEventsGroupId: result.discord_personal_events_group_id,
                  discordPersonalEventsChannelFormat: result.discord_personal_events_channel_format,
                  discordEventsChannelId: result.discord_events_channel_id,
                  requireCompleteProfile: result.require_complete_profile,
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
