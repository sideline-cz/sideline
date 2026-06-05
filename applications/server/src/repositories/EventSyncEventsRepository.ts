import { Discord, Event, GroupModel, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const EventSyncEventType = Schema.Literals([
  'event_created',
  'event_updated',
  'event_cancelled',
  'rsvp_reminder',
  'event_started',
  'training_claim_request',
  'training_claim_update',
  'unclaimed_training_reminder',
]);
type EventSyncEventType = typeof EventSyncEventType.Type;

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: EventSyncEventType,
  event_id: Schema.String,
  event_title: Schema.String,
  event_description: Schema.OptionFromNullOr(Schema.String),
  event_image_url: Schema.OptionFromNullOr(Schema.String),
  event_start_at: Schemas.DateTimeFromIsoString,
  event_end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  event_location: Schema.OptionFromNullOr(Schema.String),
  event_location_url: Schema.OptionFromNullOr(Schema.String),
  event_event_type: Schema.String,
  discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claimed_by_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  claimed_by_display_name: Schema.OptionFromNullOr(Schema.String),
  event_all_day: Schema.Boolean,
});

class GuildLookupResult extends Schema.Class<GuildLookupResult>('GuildLookupResult')({
  guild_id: Discord.Snowflake,
}) {}

export class EventSyncEventRow extends Schema.Class<EventSyncEventRow>('EventSyncEventRow')({
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: EventSyncEventType,
  event_id: Event.EventId,
  event_title: Schema.String,
  event_description: Schema.OptionFromNullOr(Schema.String),
  event_image_url: Schema.OptionFromNullOr(Schema.String),
  event_start_at: Schemas.DateTimeFromIsoString,
  event_end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  event_location: Schema.OptionFromNullOr(Schema.String),
  event_location_url: Schema.OptionFromNullOr(Schema.String),
  event_event_type: Schema.String,
  discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claimed_by_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  claimed_by_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claimed_by_name: Schema.OptionFromNullOr(Schema.String),
  claimed_by_nickname: Schema.OptionFromNullOr(Schema.String),
  claimed_by_user_display_name: Schema.OptionFromNullOr(Schema.String),
  claimed_by_username: Schema.OptionFromNullOr(Schema.String),
  event_all_day: Schema.Boolean,
}) {}

const MarkProcessedInput = Schema.Struct({
  id: Schema.String,
});

const MarkFailedInput = Schema.Struct({
  id: Schema.String,
  error: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEvent = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO event_sync_events (team_id, guild_id, event_type, event_id, event_title, event_description, event_image_url, event_start_at, event_end_at, event_location, event_location_url, event_event_type, discord_target_channel_id, member_group_id, discord_role_id, claimed_by_member_id, claimed_by_display_name, event_all_day)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.event_type}, ${input.event_id}, ${input.event_title}, ${input.event_description}, ${input.event_image_url}, ${input.event_start_at}, ${input.event_end_at}, ${input.event_location}, ${input.event_location_url}, ${input.event_event_type}, ${input.discord_target_channel_id}, ${input.member_group_id}, ${input.discord_role_id}, ${input.claimed_by_member_id}, ${input.claimed_by_display_name}, ${input.event_all_day})
    `,
  });

  const lookupGuildId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GuildLookupResult,
    execute: (teamId) => sql`SELECT guild_id FROM teams WHERE id = ${teamId}`,
  });

  const findUnprocessedEvents = SqlSchema.findAll({
    Request: Schema.Number,
    Result: EventSyncEventRow,
    execute: (limit) => sql`
      SELECT ese.id, ese.team_id, ese.guild_id, ese.event_type, ese.event_id,
             ese.event_title, ese.event_description, ese.event_image_url,
             ese.event_start_at, ese.event_end_at, ese.event_location,
             ese.event_location_url, ese.event_event_type,
             ese.discord_target_channel_id, ese.member_group_id, ese.discord_role_id,
             ese.claimed_by_member_id,
             u.discord_id           AS claimed_by_discord_id,
             COALESCE(u.name, ese.claimed_by_display_name) AS claimed_by_name,
             u.discord_nickname     AS claimed_by_nickname,
             u.discord_display_name AS claimed_by_user_display_name,
             u.username             AS claimed_by_username,
             ese.event_all_day
      FROM event_sync_events ese
      LEFT JOIN team_members tm ON tm.id = ese.claimed_by_member_id
      LEFT JOIN users u         ON u.id = tm.user_id
      WHERE ese.processed_at IS NULL
      ORDER BY ese.created_at ASC
      LIMIT ${limit}
    `,
  });

  const markEventProcessed = SqlSchema.void({
    Request: MarkProcessedInput,
    execute: (input) => sql`
      UPDATE event_sync_events SET processed_at = now() WHERE id = ${input.id}
    `,
  });

  const markEventFailed = SqlSchema.void({
    Request: MarkFailedInput,
    execute: (input) => sql`
      UPDATE event_sync_events SET processed_at = now(), error = ${input.error} WHERE id = ${input.id}
    `,
  });

  const _emitIfGuildLinked = (
    teamId: Team.TeamId,
    eventType: EventSyncEventType,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    imageUrl: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    locationUrl: Option.Option<string>,
    eventEventType: string,
    allDay: boolean = false,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    claimedByMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
    claimedByDisplayName: Option.Option<string> = Option.none(),
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertEvent({
              team_id: teamId,
              guild_id,
              event_type: eventType,
              event_id: eventId,
              event_title: title,
              event_description: description,
              event_image_url: imageUrl,
              event_start_at: startAt,
              event_end_at: endAt,
              event_location: location,
              event_location_url: locationUrl,
              event_event_type: eventEventType,
              discord_target_channel_id: discordTargetChannelId,
              member_group_id: memberGroupId,
              discord_role_id: discordRoleId,
              claimed_by_member_id: claimedByMemberId,
              claimed_by_display_name: claimedByDisplayName,
              event_all_day: allDay,
            }),
        }),
      ),
      catchSqlErrors,
    );

  const emitEventCreated = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    eventEventType: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    imageUrl: Option.Option<string> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
    allDay: boolean = false,
  ) =>
    _emitIfGuildLinked(
      teamId,
      'event_created',
      eventId,
      title,
      description,
      imageUrl,
      startAt,
      endAt,
      location,
      locationUrl,
      eventEventType,
      allDay,
      discordTargetChannelId,
      memberGroupId,
      discordRoleId,
    );

  const emitEventUpdated = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    eventEventType: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    imageUrl: Option.Option<string> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
    allDay: boolean = false,
  ) =>
    _emitIfGuildLinked(
      teamId,
      'event_updated',
      eventId,
      title,
      description,
      imageUrl,
      startAt,
      endAt,
      location,
      locationUrl,
      eventEventType,
      allDay,
      discordTargetChannelId,
      memberGroupId,
      discordRoleId,
    );

  const emitEventCancelled = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    eventEventType: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
  ) =>
    _emitIfGuildLinked(
      teamId,
      'event_cancelled',
      eventId,
      title,
      description,
      Option.none(),
      startAt,
      endAt,
      location,
      locationUrl,
      eventEventType,
      false,
      discordTargetChannelId,
      memberGroupId,
      discordRoleId,
    );

  const emitRsvpReminder = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    eventEventType: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
  ) =>
    _emitIfGuildLinked(
      teamId,
      'rsvp_reminder',
      eventId,
      title,
      description,
      Option.none(),
      startAt,
      endAt,
      location,
      locationUrl,
      eventEventType,
      false,
      discordTargetChannelId,
      memberGroupId,
      discordRoleId,
    );

  const emitEventStarted = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    description: Option.Option<string>,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    eventEventType: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    imageUrl: Option.Option<string> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
    allDay: boolean = false,
  ) =>
    _emitIfGuildLinked(
      teamId,
      'event_started',
      eventId,
      title,
      description,
      imageUrl,
      startAt,
      endAt,
      location,
      locationUrl,
      eventEventType,
      allDay,
      discordTargetChannelId,
      memberGroupId,
      discordRoleId,
    );

  const emitTrainingClaimRequest = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    description: Option.Option<string>,
    discordTargetChannelId: Discord.Snowflake,
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
  ) =>
    _emitIfGuildLinked(
      teamId,
      'training_claim_request',
      eventId,
      title,
      description,
      Option.none(),
      startAt,
      endAt,
      location,
      locationUrl,
      'training',
      false,
      Option.some(discordTargetChannelId),
      Option.none(),
      discordRoleId,
    );

  const emitTrainingClaimUpdate = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    description: Option.Option<string>,
    claimDiscordChannelId: Option.Option<Discord.Snowflake>,
    claimDiscordMessageId: Option.Option<Discord.Snowflake>,
    claimedByMemberId: Option.Option<TeamMember.TeamMemberId>,
    claimedByDisplayName: Option.Option<string>,
    eventStatus: string,
    locationUrl: Option.Option<string> = Option.none(),
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertEvent({
              team_id: teamId,
              guild_id,
              event_type: 'training_claim_update',
              event_id: eventId,
              event_title: title,
              event_description: description,
              event_image_url: Option.none(),
              event_start_at: startAt,
              event_end_at: endAt,
              event_location: location,
              event_location_url: locationUrl,
              event_event_type: eventStatus,
              discord_target_channel_id: claimDiscordChannelId,
              member_group_id: Option.none(),
              discord_role_id: claimDiscordMessageId,
              claimed_by_member_id: claimedByMemberId,
              claimed_by_display_name: claimedByDisplayName,
              event_all_day: false,
            }),
        }),
      ),
      catchSqlErrors,
    );

  const emitUnclaimedTrainingReminder = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    startAt: DateTime.Utc,
    endAt: Option.Option<DateTime.Utc>,
    location: Option.Option<string>,
    discordTargetChannelId: Discord.Snowflake,
    discordRoleId: Option.Option<Discord.Snowflake> = Option.none(),
    _claimDiscordChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    _claimDiscordMessageId: Option.Option<Discord.Snowflake> = Option.none(),
    locationUrl: Option.Option<string> = Option.none(),
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertEvent({
              team_id: teamId,
              guild_id,
              event_type: 'unclaimed_training_reminder',
              event_id: eventId,
              event_title: title,
              event_description: Option.none(),
              event_image_url: Option.none(),
              event_start_at: startAt,
              event_end_at: endAt,
              event_location: location,
              event_location_url: locationUrl,
              event_event_type: 'training',
              discord_target_channel_id: Option.some(discordTargetChannelId),
              member_group_id: Option.none(),
              discord_role_id: discordRoleId,
              claimed_by_member_id: Option.none(),
              claimed_by_display_name: Option.none(),
              event_all_day: false,
            }),
        }),
      ),
      catchSqlErrors,
    );

  const findUnprocessed = (limit: number) => findUnprocessedEvents(limit).pipe(catchSqlErrors);

  const markProcessed = (id: string) => markEventProcessed({ id }).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) =>
    markEventFailed({ id, error }).pipe(catchSqlErrors);

  return {
    emitEventCreated,
    emitEventUpdated,
    emitEventCancelled,
    emitRsvpReminder,
    emitEventStarted,
    emitTrainingClaimRequest,
    emitTrainingClaimUpdate,
    emitUnclaimedTrainingReminder,
    findUnprocessed,
    markProcessed,
    markFailed,
  };
});

export class EventSyncEventsRepository extends ServiceMap.Service<
  EventSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/EventSyncEventsRepository') {
  static readonly Default = Layer.effect(EventSyncEventsRepository, make);
}
