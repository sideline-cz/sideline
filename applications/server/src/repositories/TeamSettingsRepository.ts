import { ChannelSyncEvent, Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import {
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';

class TeamSettingsRow extends Schema.Class<TeamSettingsRow>('TeamSettingsRow')({
  team_id: Team.TeamId,
  event_horizon_days: Schema.Number,
  min_players_threshold: Schema.Number,
  rsvp_reminders_enabled: Schema.Boolean,
  rsvp_reminder_days_before: Schema.Number,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
  discord_channel_late_rsvp: Schema.OptionFromNullOr(Discord.Snowflake),
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_roster_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_personal_events_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_personal_events_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_personal_events_channel_format: Schema.String,
  discord_events_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelSyncEvent.ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelSyncEvent.ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  weekly_summary_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claim_request_days_before: Schema.Number,
  max_missed_rsvps: Schema.Number,
}) {}

class WeeklySummaryTeamRow extends Schema.Class<WeeklySummaryTeamRow>('WeeklySummaryTeamRow')({
  team_id: Team.TeamId,
  timezone: Schema.String,
  weekly_summary_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const TeamSettingsUpsertInput = Schema.Struct({
  team_id: Schema.String,
  event_horizon_days: Schema.Number,
  min_players_threshold: Schema.Number,
  rsvp_reminders_enabled: Schema.Boolean,
  rsvp_reminder_days_before: Schema.Number,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
  discord_channel_late_rsvp: Schema.OptionFromNullOr(Discord.Snowflake),
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_roster_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_personal_events_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_personal_events_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_personal_events_channel_format: Schema.String,
  discord_events_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelSyncEvent.ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelSyncEvent.ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  weekly_summary_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claim_request_days_before: Schema.Number,
  max_missed_rsvps: Schema.Number,
});

class EventNeedingClaimRequest extends Schema.Class<EventNeedingClaimRequest>(
  'EventNeedingClaimRequest',
)({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  title: Schema.String,
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  description: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
}) {}

class EventNeedingCoachingStatus extends Schema.Class<EventNeedingCoachingStatus>(
  'EventNeedingCoachingStatus',
)({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  title: Schema.String,
  start_at: Schemas.DateTimeFromDate,
  location: Schema.OptionFromNullOr(Schema.String),
  timezone: Schema.String,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  claimed_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  claimer_display_name: Schema.OptionFromNullOr(Schema.String),
  claimer_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class EventNeedingReminder extends Schema.Class<EventNeedingReminder>('EventNeedingReminder')({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  title: Schema.String,
  start_at: Schemas.DateTimeFromDate,
  event_type: Schema.String,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
  claimed_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  claim_discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claim_discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _findByTeam = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: TeamSettingsRow,
    execute: (teamId) => sql`
      SELECT team_id, event_horizon_days,
             min_players_threshold,
             rsvp_reminders_enabled,
             rsvp_reminder_days_before, TO_CHAR(rsvp_reminder_time, 'HH24:MI') AS rsvp_reminder_time,
             reminders_channel_id, timezone,
             discord_channel_late_rsvp,
             create_discord_channel_on_group, create_discord_channel_on_roster,
             discord_archive_category_id,
             discord_roster_category_id,
             discord_personal_events_category_id,
             discord_personal_events_group_id,
             discord_personal_events_channel_format,
             discord_events_channel_id,
             discord_channel_cleanup_on_group_delete,
             discord_channel_cleanup_on_roster_deactivate,
             discord_role_format,
             discord_channel_format,
             weekly_summary_channel_id,
             claim_request_days_before,
             max_missed_rsvps
      FROM team_settings
      WHERE team_id = ${teamId}
    `,
  });

  const _findAllWithWeeklySummaryChannel = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WeeklySummaryTeamRow,
    execute: () => sql`
      SELECT team_id, timezone, weekly_summary_channel_id
      FROM team_settings
      WHERE weekly_summary_channel_id IS NOT NULL
    `,
  });

  const _upsertSettings = SqlSchema.findOne({
    Request: TeamSettingsUpsertInput,
    Result: TeamSettingsRow,
    execute: (input) => sql`
      INSERT INTO team_settings (team_id, event_horizon_days,
                                 min_players_threshold,
                                 rsvp_reminders_enabled,
                                 rsvp_reminder_days_before, rsvp_reminder_time,
                                 reminders_channel_id, timezone,
                                 discord_channel_late_rsvp,
                                 create_discord_channel_on_group, create_discord_channel_on_roster,
                                 discord_archive_category_id,
                                 discord_roster_category_id,
                                 discord_personal_events_category_id,
                                 discord_personal_events_group_id,
                                 discord_personal_events_channel_format,
                                 discord_events_channel_id,
                                 discord_channel_cleanup_on_group_delete,
                                 discord_channel_cleanup_on_roster_deactivate,
                                 discord_role_format,
                                 discord_channel_format,
                                 weekly_summary_channel_id,
                                 claim_request_days_before,
                                 max_missed_rsvps)
      VALUES (${input.team_id}, ${input.event_horizon_days},
              ${input.min_players_threshold},
              ${input.rsvp_reminders_enabled},
              ${input.rsvp_reminder_days_before}, ${input.rsvp_reminder_time},
              ${input.reminders_channel_id}, ${input.timezone},
              ${input.discord_channel_late_rsvp},
              ${input.create_discord_channel_on_group}, ${input.create_discord_channel_on_roster},
              ${input.discord_archive_category_id},
              ${input.discord_roster_category_id},
              ${input.discord_personal_events_category_id},
              ${input.discord_personal_events_group_id},
              ${input.discord_personal_events_channel_format},
              ${input.discord_events_channel_id},
              ${input.discord_channel_cleanup_on_group_delete},
              ${input.discord_channel_cleanup_on_roster_deactivate},
              ${input.discord_role_format},
              ${input.discord_channel_format},
              ${input.weekly_summary_channel_id},
              ${input.claim_request_days_before},
              ${input.max_missed_rsvps})
      ON CONFLICT (team_id) DO UPDATE SET
        event_horizon_days = ${input.event_horizon_days},
        min_players_threshold = ${input.min_players_threshold},
        rsvp_reminders_enabled = ${input.rsvp_reminders_enabled},
        rsvp_reminder_days_before = ${input.rsvp_reminder_days_before},
        rsvp_reminder_time = ${input.rsvp_reminder_time},
        reminders_channel_id = ${input.reminders_channel_id},
        timezone = ${input.timezone},
        discord_channel_late_rsvp = ${input.discord_channel_late_rsvp},
        create_discord_channel_on_group = ${input.create_discord_channel_on_group},
        create_discord_channel_on_roster = ${input.create_discord_channel_on_roster},
        discord_archive_category_id = ${input.discord_archive_category_id},
        discord_roster_category_id = ${input.discord_roster_category_id},
        discord_personal_events_category_id = ${input.discord_personal_events_category_id},
        discord_personal_events_group_id = ${input.discord_personal_events_group_id},
        discord_personal_events_channel_format = ${input.discord_personal_events_channel_format},
        discord_events_channel_id = ${input.discord_events_channel_id},
        discord_channel_cleanup_on_group_delete = ${input.discord_channel_cleanup_on_group_delete},
        discord_channel_cleanup_on_roster_deactivate = ${input.discord_channel_cleanup_on_roster_deactivate},
        discord_role_format = ${input.discord_role_format},
        discord_channel_format = ${input.discord_channel_format},
        weekly_summary_channel_id = ${input.weekly_summary_channel_id},
        claim_request_days_before = ${input.claim_request_days_before},
        max_missed_rsvps = ${input.max_missed_rsvps},
        updated_at = now()
      RETURNING team_id, event_horizon_days,
                min_players_threshold,
                rsvp_reminders_enabled,
                rsvp_reminder_days_before, TO_CHAR(rsvp_reminder_time, 'HH24:MI') AS rsvp_reminder_time,
                reminders_channel_id, timezone,
                discord_channel_late_rsvp,
                create_discord_channel_on_group, create_discord_channel_on_roster,
                discord_archive_category_id,
                discord_roster_category_id,
                discord_personal_events_category_id,
                discord_personal_events_group_id,
                discord_personal_events_channel_format,
                discord_events_channel_id,
                discord_channel_cleanup_on_group_delete,
                discord_channel_cleanup_on_roster_deactivate,
                discord_role_format,
                discord_channel_format,
                weekly_summary_channel_id,
                claim_request_days_before,
                max_missed_rsvps
    `,
  });

  const _getHorizon = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ event_horizon_days: Schema.Number }),
    execute: (teamId) => sql`
      SELECT COALESCE(ts.event_horizon_days, 30) AS event_horizon_days
      FROM (SELECT ${teamId}::uuid AS id) t
      LEFT JOIN team_settings ts ON ts.team_id = t.id
    `,
  });

  const _findEventsForReminderAt = (nowParam: string) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: EventNeedingReminder,
      execute: () => sql`
        SELECT e.id AS event_id, e.team_id, e.title, e.start_at, e.event_type,
               e.owner_group_id, e.member_group_id,
               ts.reminders_channel_id, ts.timezone,
               e.claimed_by, e.claim_discord_channel_id, e.claim_discord_message_id
        FROM events e
        JOIN team_settings ts ON ts.team_id = e.team_id
        WHERE e.status = 'active'
          AND e.reminder_sent_at IS NULL
          AND ts.rsvp_reminders_enabled = TRUE
          AND DATE((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)
              + ts.rsvp_reminder_days_before
              = DATE(e.start_at AT TIME ZONE ts.timezone)
          AND ((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)::time
              BETWEEN ts.rsvp_reminder_time
              AND ts.rsvp_reminder_time::time + INTERVAL '5 minutes'
          AND e.start_at > (${nowParam}::timestamptz)
      `,
    });

  const _findEventsForClaimRequestAt = (nowParam: string) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: EventNeedingClaimRequest,
      execute: () => sql`
        SELECT e.id AS event_id, e.team_id, e.title, e.start_at,
               e.end_at, e.location, e.description, e.event_type,
               e.owner_group_id, e.member_group_id,
               ts.reminders_channel_id, ts.timezone
        FROM events e
        JOIN team_settings ts ON ts.team_id = e.team_id
        WHERE e.status = 'active'
          AND e.event_type = 'training'
          AND e.claim_request_sent_at IS NULL
          AND e.start_at > (${nowParam}::timestamptz)
          AND DATE(e.start_at AT TIME ZONE ts.timezone) - ts.claim_request_days_before
              <= DATE((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)
      `,
    });

  const _findEventsForCoachingStatusAt = (nowParam: string) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: EventNeedingCoachingStatus,
      execute: () => sql`
        SELECT e.id AS event_id, e.team_id, e.title, e.start_at,
               e.location, ts.timezone,
               e.owner_group_id,
               e.claimed_by,
               u.name AS claimer_display_name,
               u.discord_id AS claimer_discord_id
        FROM events e
        JOIN team_settings ts ON ts.team_id = e.team_id
        LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
        LEFT JOIN users u ON u.id = ctm.user_id
        WHERE e.status = 'active'
          AND e.event_type = 'training'
          AND e.coaching_status_sent_at IS NULL
          AND e.claimed_by IS NOT NULL
          AND e.start_at > (${nowParam}::timestamptz)
          AND DATE(e.start_at AT TIME ZONE ts.timezone)
              = DATE((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)
          AND ((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)::time >= TIME '07:00'
      `,
    });

  const findByTeamId = (teamId: Team.TeamId) => _findByTeam(teamId).pipe(catchSqlErrors);

  const upsert = ({
    teamId,
    eventHorizonDays,
    minPlayersThreshold,
    rsvpRemindersEnabled = true,
    rsvpReminderDaysBefore = 1,
    rsvpReminderTime = '18:00',
    remindersChannelId = Option.none(),
    timezone = 'Europe/Prague',
    discordChannelLateRsvp = Option.none(),
    createDiscordChannelOnGroup = true,
    createDiscordChannelOnRoster = true,
    discordArchiveCategoryId = Option.none(),
    discordRosterCategoryId = Option.none(),
    discordPersonalEventsCategoryId = Option.none(),
    discordPersonalEventsGroupId = Option.none(),
    discordPersonalEventsChannelFormat = DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
    discordEventsChannelId = Option.none(),
    discordChannelCleanupOnGroupDelete = 'delete' as ChannelSyncEvent.ChannelCleanupMode,
    discordChannelCleanupOnRosterDeactivate = 'delete' as ChannelSyncEvent.ChannelCleanupMode,
    discordRoleFormat = DEFAULT_ROLE_FORMAT,
    discordChannelFormat = DEFAULT_CHANNEL_FORMAT,
    weeklySummaryChannelId = Option.none<Discord.Snowflake>(),
    claimRequestDaysBefore = 3,
    maxMissedRsvps = 4,
  }: {
    teamId: Team.TeamId;
    eventHorizonDays: number;
    minPlayersThreshold: number;
    rsvpRemindersEnabled?: boolean;
    rsvpReminderDaysBefore?: number;
    rsvpReminderTime?: string;
    remindersChannelId?: Option.Option<Discord.Snowflake>;
    timezone?: string;
    discordChannelLateRsvp?: Option.Option<Discord.Snowflake>;
    createDiscordChannelOnGroup?: boolean;
    createDiscordChannelOnRoster?: boolean;
    discordArchiveCategoryId?: Option.Option<Discord.Snowflake>;
    discordRosterCategoryId?: Option.Option<Discord.Snowflake>;
    discordPersonalEventsCategoryId?: Option.Option<Discord.Snowflake>;
    discordPersonalEventsGroupId?: Option.Option<GroupModel.GroupId>;
    discordPersonalEventsChannelFormat?: string;
    discordEventsChannelId?: Option.Option<Discord.Snowflake>;
    discordChannelCleanupOnGroupDelete?: ChannelSyncEvent.ChannelCleanupMode;
    discordChannelCleanupOnRosterDeactivate?: ChannelSyncEvent.ChannelCleanupMode;
    discordRoleFormat?: string;
    discordChannelFormat?: string;
    weeklySummaryChannelId?: Option.Option<Discord.Snowflake>;
    claimRequestDaysBefore?: number;
    maxMissedRsvps?: number;
  }) =>
    _upsertSettings({
      team_id: teamId,
      event_horizon_days: eventHorizonDays,
      min_players_threshold: minPlayersThreshold,
      rsvp_reminders_enabled: rsvpRemindersEnabled,
      rsvp_reminder_days_before: rsvpReminderDaysBefore,
      rsvp_reminder_time: rsvpReminderTime,
      reminders_channel_id: remindersChannelId,
      timezone,
      discord_channel_late_rsvp: discordChannelLateRsvp,
      create_discord_channel_on_group: createDiscordChannelOnGroup,
      create_discord_channel_on_roster: createDiscordChannelOnRoster,
      discord_archive_category_id: discordArchiveCategoryId,
      discord_roster_category_id: discordRosterCategoryId,
      discord_personal_events_category_id: discordPersonalEventsCategoryId,
      discord_personal_events_group_id: discordPersonalEventsGroupId,
      discord_personal_events_channel_format: discordPersonalEventsChannelFormat,
      discord_events_channel_id: discordEventsChannelId,
      discord_channel_cleanup_on_group_delete: discordChannelCleanupOnGroupDelete,
      discord_channel_cleanup_on_roster_deactivate: discordChannelCleanupOnRosterDeactivate,
      discord_role_format: discordRoleFormat,
      discord_channel_format: discordChannelFormat,
      weekly_summary_channel_id: weeklySummaryChannelId,
      claim_request_days_before: claimRequestDaysBefore,
      max_missed_rsvps: maxMissedRsvps,
    }).pipe(catchSqlErrors);

  const getHorizonDays = (teamId: Team.TeamId) =>
    _getHorizon(teamId).pipe(
      Effect.map((r) => r.event_horizon_days),
      catchSqlErrors,
    );

  const findLateRsvpChannelId = (teamId: Team.TeamId) =>
    findByTeamId(teamId).pipe(
      Effect.map(Option.flatMap((s) => s.discord_channel_late_rsvp)),
      catchSqlErrors,
    );

  const findEventsNeedingReminderAt = (now: Date) =>
    _findEventsForReminderAt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const findEventsNeedingReminder = () => findEventsNeedingReminderAt(new Date());

  const findEventsNeedingClaimRequestAt = (now: Date) =>
    _findEventsForClaimRequestAt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const findEventsNeedingClaimRequest = () => findEventsNeedingClaimRequestAt(new Date());

  const findEventsNeedingCoachingStatusAt = (now: Date) =>
    _findEventsForCoachingStatusAt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const findEventsNeedingCoachingStatus = () => findEventsNeedingCoachingStatusAt(new Date());

  const findAllWithWeeklySummaryChannel = () =>
    _findAllWithWeeklySummaryChannel(undefined).pipe(catchSqlErrors);

  return {
    findByTeamId,
    upsert,
    getHorizonDays,
    findLateRsvpChannelId,
    findEventsNeedingReminder,
    findEventsNeedingReminderAt,
    findEventsNeedingClaimRequest,
    findEventsNeedingClaimRequestAt,
    findEventsNeedingCoachingStatus,
    findEventsNeedingCoachingStatusAt,
    findAllWithWeeklySummaryChannel,
  };
});

export class TeamSettingsRepository extends ServiceMap.Service<
  TeamSettingsRepository,
  Effect.Success<typeof make>
>()('api/TeamSettingsRepository') {
  static readonly Default = Layer.effect(TeamSettingsRepository, make);
}
