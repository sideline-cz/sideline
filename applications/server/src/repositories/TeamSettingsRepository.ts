import { ChannelSyncEvent, Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { DEFAULT_CHANNEL_FORMAT, DEFAULT_ROLE_FORMAT } from '~/utils/applyDiscordFormat.js';

class TeamSettingsRow extends Schema.Class<TeamSettingsRow>('TeamSettingsRow')({
  team_id: Team.TeamId,
  event_horizon_days: Schema.Number,
  min_players_threshold: Schema.Number,
  rsvp_reminder_days_before: Schema.Number,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
  discord_channel_training: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_match: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_tournament: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_meeting: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_social: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_other: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_late_rsvp: Schema.OptionFromNullOr(Discord.Snowflake),
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelSyncEvent.ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelSyncEvent.ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  weekly_summary_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
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
  rsvp_reminder_days_before: Schema.Number,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  timezone: Schema.String,
  discord_channel_training: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_match: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_tournament: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_meeting: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_social: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_other: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_late_rsvp: Schema.OptionFromNullOr(Discord.Snowflake),
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelSyncEvent.ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelSyncEvent.ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  weekly_summary_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
});

class EventNeedingReminder extends Schema.Class<EventNeedingReminder>('EventNeedingReminder')({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  title: Schema.String,
  start_at: Schemas.DateTimeFromDate,
  event_type: Schema.String,
  discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
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
             rsvp_reminder_days_before, TO_CHAR(rsvp_reminder_time, 'HH24:MI') AS rsvp_reminder_time,
             reminders_channel_id, timezone,
             discord_channel_training, discord_channel_match,
             discord_channel_tournament, discord_channel_meeting,
             discord_channel_social, discord_channel_other,
             discord_channel_late_rsvp,
             create_discord_channel_on_group, create_discord_channel_on_roster,
             discord_archive_category_id,
             discord_channel_cleanup_on_group_delete,
             discord_channel_cleanup_on_roster_deactivate,
             discord_role_format,
             discord_channel_format,
             weekly_summary_channel_id
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
                                 rsvp_reminder_days_before, rsvp_reminder_time,
                                 reminders_channel_id, timezone,
                                 discord_channel_training, discord_channel_match,
                                 discord_channel_tournament, discord_channel_meeting,
                                 discord_channel_social, discord_channel_other,
                                 discord_channel_late_rsvp,
                                 create_discord_channel_on_group, create_discord_channel_on_roster,
                                 discord_archive_category_id,
                                 discord_channel_cleanup_on_group_delete,
                                 discord_channel_cleanup_on_roster_deactivate,
                                 discord_role_format,
                                 discord_channel_format,
                                 weekly_summary_channel_id)
      VALUES (${input.team_id}, ${input.event_horizon_days},
              ${input.min_players_threshold},
              ${input.rsvp_reminder_days_before}, ${input.rsvp_reminder_time},
              ${input.reminders_channel_id}, ${input.timezone},
              ${input.discord_channel_training}, ${input.discord_channel_match},
              ${input.discord_channel_tournament}, ${input.discord_channel_meeting},
              ${input.discord_channel_social}, ${input.discord_channel_other},
              ${input.discord_channel_late_rsvp},
              ${input.create_discord_channel_on_group}, ${input.create_discord_channel_on_roster},
              ${input.discord_archive_category_id},
              ${input.discord_channel_cleanup_on_group_delete},
              ${input.discord_channel_cleanup_on_roster_deactivate},
              ${input.discord_role_format},
              ${input.discord_channel_format},
              ${input.weekly_summary_channel_id})
      ON CONFLICT (team_id) DO UPDATE SET
        event_horizon_days = ${input.event_horizon_days},
        min_players_threshold = ${input.min_players_threshold},
        rsvp_reminder_days_before = ${input.rsvp_reminder_days_before},
        rsvp_reminder_time = ${input.rsvp_reminder_time},
        reminders_channel_id = ${input.reminders_channel_id},
        timezone = ${input.timezone},
        discord_channel_training = ${input.discord_channel_training},
        discord_channel_match = ${input.discord_channel_match},
        discord_channel_tournament = ${input.discord_channel_tournament},
        discord_channel_meeting = ${input.discord_channel_meeting},
        discord_channel_social = ${input.discord_channel_social},
        discord_channel_other = ${input.discord_channel_other},
        discord_channel_late_rsvp = ${input.discord_channel_late_rsvp},
        create_discord_channel_on_group = ${input.create_discord_channel_on_group},
        create_discord_channel_on_roster = ${input.create_discord_channel_on_roster},
        discord_archive_category_id = ${input.discord_archive_category_id},
        discord_channel_cleanup_on_group_delete = ${input.discord_channel_cleanup_on_group_delete},
        discord_channel_cleanup_on_roster_deactivate = ${input.discord_channel_cleanup_on_roster_deactivate},
        discord_role_format = ${input.discord_role_format},
        discord_channel_format = ${input.discord_channel_format},
        weekly_summary_channel_id = ${input.weekly_summary_channel_id},
        updated_at = now()
      RETURNING team_id, event_horizon_days,
                min_players_threshold,
                rsvp_reminder_days_before, TO_CHAR(rsvp_reminder_time, 'HH24:MI') AS rsvp_reminder_time,
                reminders_channel_id, timezone,
                discord_channel_training, discord_channel_match,
                discord_channel_tournament, discord_channel_meeting,
                discord_channel_social, discord_channel_other,
                discord_channel_late_rsvp,
                create_discord_channel_on_group, create_discord_channel_on_roster,
                discord_archive_category_id,
                discord_channel_cleanup_on_group_delete,
                discord_channel_cleanup_on_roster_deactivate,
                discord_role_format,
                discord_channel_format,
                weekly_summary_channel_id
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
               e.discord_target_channel_id, e.owner_group_id, e.member_group_id,
               ts.reminders_channel_id, ts.timezone,
               e.claimed_by, e.claim_discord_channel_id, e.claim_discord_message_id
        FROM events e
        JOIN team_settings ts ON ts.team_id = e.team_id
        WHERE e.status = 'active'
          AND e.reminder_sent_at IS NULL
          AND ts.rsvp_reminder_days_before > 0
          AND DATE((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)
              + ts.rsvp_reminder_days_before
              = DATE(e.start_at AT TIME ZONE ts.timezone)
          AND ((${nowParam}::timestamptz) AT TIME ZONE ts.timezone)::time
              BETWEEN ts.rsvp_reminder_time
              AND ts.rsvp_reminder_time::time + INTERVAL '5 minutes'
          AND e.start_at > (${nowParam}::timestamptz)
      `,
    });

  const findByTeamId = (teamId: Team.TeamId) => _findByTeam(teamId).pipe(catchSqlErrors);

  const upsert = ({
    teamId,
    eventHorizonDays,
    minPlayersThreshold,
    rsvpReminderDaysBefore = 1,
    rsvpReminderTime = '18:00',
    remindersChannelId = Option.none(),
    timezone = 'Europe/Prague',
    discordChannelTraining = Option.none(),
    discordChannelMatch = Option.none(),
    discordChannelTournament = Option.none(),
    discordChannelMeeting = Option.none(),
    discordChannelSocial = Option.none(),
    discordChannelOther = Option.none(),
    discordChannelLateRsvp = Option.none(),
    createDiscordChannelOnGroup = true,
    createDiscordChannelOnRoster = true,
    discordArchiveCategoryId = Option.none(),
    discordChannelCleanupOnGroupDelete = 'delete' as ChannelSyncEvent.ChannelCleanupMode,
    discordChannelCleanupOnRosterDeactivate = 'delete' as ChannelSyncEvent.ChannelCleanupMode,
    discordRoleFormat = DEFAULT_ROLE_FORMAT,
    discordChannelFormat = DEFAULT_CHANNEL_FORMAT,
    weeklySummaryChannelId = Option.none<Discord.Snowflake>(),
  }: {
    teamId: Team.TeamId;
    eventHorizonDays: number;
    minPlayersThreshold: number;
    rsvpReminderDaysBefore?: number;
    rsvpReminderTime?: string;
    remindersChannelId?: Option.Option<Discord.Snowflake>;
    timezone?: string;
    discordChannelTraining?: Option.Option<Discord.Snowflake>;
    discordChannelMatch?: Option.Option<Discord.Snowflake>;
    discordChannelTournament?: Option.Option<Discord.Snowflake>;
    discordChannelMeeting?: Option.Option<Discord.Snowflake>;
    discordChannelSocial?: Option.Option<Discord.Snowflake>;
    discordChannelOther?: Option.Option<Discord.Snowflake>;
    discordChannelLateRsvp?: Option.Option<Discord.Snowflake>;
    createDiscordChannelOnGroup?: boolean;
    createDiscordChannelOnRoster?: boolean;
    discordArchiveCategoryId?: Option.Option<Discord.Snowflake>;
    discordChannelCleanupOnGroupDelete?: ChannelSyncEvent.ChannelCleanupMode;
    discordChannelCleanupOnRosterDeactivate?: ChannelSyncEvent.ChannelCleanupMode;
    discordRoleFormat?: string;
    discordChannelFormat?: string;
    weeklySummaryChannelId?: Option.Option<Discord.Snowflake>;
  }) =>
    _upsertSettings({
      team_id: teamId,
      event_horizon_days: eventHorizonDays,
      min_players_threshold: minPlayersThreshold,
      rsvp_reminder_days_before: rsvpReminderDaysBefore,
      rsvp_reminder_time: rsvpReminderTime,
      reminders_channel_id: remindersChannelId,
      timezone,
      discord_channel_training: discordChannelTraining,
      discord_channel_match: discordChannelMatch,
      discord_channel_tournament: discordChannelTournament,
      discord_channel_meeting: discordChannelMeeting,
      discord_channel_social: discordChannelSocial,
      discord_channel_other: discordChannelOther,
      discord_channel_late_rsvp: discordChannelLateRsvp,
      create_discord_channel_on_group: createDiscordChannelOnGroup,
      create_discord_channel_on_roster: createDiscordChannelOnRoster,
      discord_archive_category_id: discordArchiveCategoryId,
      discord_channel_cleanup_on_group_delete: discordChannelCleanupOnGroupDelete,
      discord_channel_cleanup_on_roster_deactivate: discordChannelCleanupOnRosterDeactivate,
      discord_role_format: discordRoleFormat,
      discord_channel_format: discordChannelFormat,
      weekly_summary_channel_id: weeklySummaryChannelId,
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
    _findEventsForReminderAt(now.toISOString())(undefined as undefined).pipe(catchSqlErrors);

  const findEventsNeedingReminder = () => findEventsNeedingReminderAt(new Date());

  const findAllWithWeeklySummaryChannel = () =>
    _findAllWithWeeklySummaryChannel(undefined as unknown as undefined).pipe(catchSqlErrors);

  return {
    findByTeamId,
    upsert,
    getHorizonDays,
    findLateRsvpChannelId,
    findEventsNeedingReminder,
    findEventsNeedingReminderAt,
    findAllWithWeeklySummaryChannel,
  };
});

export class TeamSettingsRepository extends ServiceMap.Service<
  TeamSettingsRepository,
  Effect.Success<typeof make>
>()('api/TeamSettingsRepository') {
  static readonly Default = Layer.effect(TeamSettingsRepository, make);
}
