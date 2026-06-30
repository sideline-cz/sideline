import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Forbidden } from '~/api/EventApi.js';
import { ChannelCleanupMode } from '~/models/ChannelSyncEvent.js';
import { Snowflake } from '~/models/Discord.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';

const DiscordFormatString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((s) => (s.includes('{name}') ? true : 'Format must include {name}')),
  ),
);

// Personal events channel name template. Placeholders {name}/{discord_id} are
// optional — a static name is fine since each personal channel is private (only
// its member sees it) and the bot tracks channels by id, not name. Just require
// a non-empty template so generated channel names are never blank.
const PersonalEventsChannelFormatString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((s) => (s.trim().length > 0 ? true : 'Format must not be empty')),
  ),
);

const isValidIanaTimezone = (tz: string): boolean => {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export class TeamSettingsInfo extends Schema.Class<TeamSettingsInfo>('TeamSettingsInfo')({
  teamId: TeamId,
  eventHorizonDays: Schema.Int,
  minPlayersThreshold: Schema.Int,
  rsvpRemindersEnabled: Schema.Boolean,
  rsvpReminderDaysBefore: Schema.Int,
  maxMissedRsvps: Schema.Int,
  claimRequestDaysBefore: Schema.Int,
  rsvpReminderTime: Schema.String,
  remindersChannelId: Schema.OptionFromNullOr(Snowflake),
  timezone: Schema.String,
  discordChannelTraining: Schema.OptionFromNullOr(Snowflake),
  discordChannelMatch: Schema.OptionFromNullOr(Snowflake),
  discordChannelTournament: Schema.OptionFromNullOr(Snowflake),
  discordChannelMeeting: Schema.OptionFromNullOr(Snowflake),
  discordChannelSocial: Schema.OptionFromNullOr(Snowflake),
  discordChannelOther: Schema.OptionFromNullOr(Snowflake),
  discordChannelLateRsvp: Schema.OptionFromNullOr(Snowflake),
  createDiscordChannelOnGroup: Schema.Boolean,
  createDiscordChannelOnRoster: Schema.Boolean,
  discordArchiveCategoryId: Schema.OptionFromNullOr(Snowflake),
  discordRosterCategoryId: Schema.OptionFromNullOr(Snowflake),
  discordPersonalEventsCategoryId: Schema.OptionFromNullOr(Snowflake),
  discordPersonalEventsGroupId: Schema.OptionFromNullOr(GroupId),
  discordPersonalEventsChannelFormat: Schema.String,
  discordEventsChannelId: Schema.OptionFromNullOr(Snowflake),
  discordChannelCleanupOnGroupDelete: ChannelCleanupMode,
  discordChannelCleanupOnRosterDeactivate: ChannelCleanupMode,
  discordRoleFormat: Schema.String,
  discordChannelFormat: Schema.String,
}) {}

export const UpdateTeamSettingsRequest = Schema.Struct({
  eventHorizonDays: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
  ),
  minPlayersThreshold: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  ),
  rsvpRemindersEnabled: Schema.OptionFromOptional(Schema.Boolean),
  rsvpReminderDaysBefore: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 14 }))),
  ),
  maxMissedRsvps: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  ),
  claimRequestDaysBefore: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
  ),
  rsvpReminderTime: Schema.OptionFromOptional(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter<string>((s) => {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return 'Must be a valid HH:MM time';
          const [hh, mm] = s.split(':').map(Number);
          if (hh === 23 && mm >= 55)
            return 'Reminder time must be 23:54 or earlier to avoid midnight wrap';
          return true;
        }),
      ),
    ),
  ),
  remindersChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  timezone: Schema.OptionFromOptional(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter<string>((tz) =>
          isValidIanaTimezone(tz) ? true : 'Must be a valid IANA timezone',
        ),
      ),
    ),
  ),
  discordChannelTraining: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelMatch: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelTournament: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelMeeting: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelSocial: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelOther: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelLateRsvp: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  createDiscordChannelOnGroup: Schema.OptionFromOptional(Schema.Boolean),
  createDiscordChannelOnRoster: Schema.OptionFromOptional(Schema.Boolean),
  discordArchiveCategoryId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordRosterCategoryId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordPersonalEventsCategoryId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordPersonalEventsGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
  discordPersonalEventsChannelFormat: Schema.OptionFromOptional(PersonalEventsChannelFormatString),
  discordEventsChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  discordChannelCleanupOnGroupDelete: Schema.OptionFromOptional(ChannelCleanupMode),
  discordChannelCleanupOnRosterDeactivate: Schema.OptionFromOptional(ChannelCleanupMode),
  discordRoleFormat: Schema.OptionFromOptional(DiscordFormatString),
  discordChannelFormat: Schema.OptionFromOptional(DiscordFormatString),
});
export type UpdateTeamSettingsRequest = Schema.Schema.Type<typeof UpdateTeamSettingsRequest>;

export class TeamSettingsApiGroup extends HttpApiGroup.make('teamSettings')
  .add(
    HttpApiEndpoint.get('getTeamSettings', '/teams/:teamId/settings', {
      success: TeamSettingsInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateTeamSettings', '/teams/:teamId/settings', {
      success: TeamSettingsInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateTeamSettingsRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
