import {
  Discord,
  Event,
  type EventRosterModel,
  EventRpcEvents,
  GroupModel,
  type RosterModel,
  Team,
  TeamMember,
} from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
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
  'coaching_status',
  'event_roster_approval_request',
  'event_roster_approval_cancel',
  'event_roster_thread_delete',
  'teams_generated',
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

// Separate insert schema for roster-type events which overload columns with non-Snowflake values.
const RosterInsertInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: EventSyncEventType,
  event_id: Event.EventId,
  event_title: Schema.String,
  event_description: Schema.OptionFromNullOr(Schema.String), // overloaded: roster_name
  event_start_at: Schemas.DateTimeFromIsoString,
  discord_target_channel_id: Schema.OptionFromNullOr(Schema.String), // overloaded: event_roster_id
  member_group_id: Schema.OptionFromNullOr(Schema.String), // overloaded: roster_id
  discord_role_id: Schema.OptionFromNullOr(Schema.String), // overloaded: owner_channel_id / message_id
  claimed_by_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId), // team_member_id (candidate)
  claimed_by_display_name: Schema.OptionFromNullOr(Schema.String), // candidate_display_name
  event_location: Schema.OptionFromNullOr(Schema.String), // overloaded: owners_thread_id
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
  // Nullable JSONB; only populated for 'teams_generated' rows.
  // node-pg auto-parses JSONB into a JS object/array, so we use the array schema directly.
  teams_payload: Schema.OptionFromNullOr(Schema.Array(EventRpcEvents.TeamsGeneratedTeam)),
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
             ese.event_all_day,
             ese.teams_payload
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
    claimedByMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
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
      claimedByMemberId,
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
    ownerGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
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
      ownerGroupId,
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

  const emitCoachingStatus = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    title: string,
    startAt: DateTime.Utc,
    discordTargetChannelId: Discord.Snowflake,
    claimedByMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
    claimedByDisplayName: Option.Option<string> = Option.none(),
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
              event_type: 'coaching_status',
              event_id: eventId,
              event_title: title,
              event_description: Option.none(),
              event_image_url: Option.none(),
              event_start_at: startAt,
              event_end_at: Option.none(),
              event_location: Option.none(),
              event_location_url: locationUrl,
              event_event_type: 'training',
              discord_target_channel_id: Option.some(discordTargetChannelId),
              member_group_id: Option.none(),
              discord_role_id: Option.none(),
              claimed_by_member_id: claimedByMemberId,
              claimed_by_display_name: claimedByDisplayName,
              event_all_day: false,
            }),
        }),
      ),
      catchSqlErrors,
    );

  // ---- Teams generated event --------------------------------------------------

  // Idempotent insert-if-not-pending: the row is only written when no unprocessed
  // 'teams_generated' row already exists for the event. The `WHERE NOT EXISTS` fast-path
  // skips the common case, and `ON CONFLICT DO NOTHING` against the partial unique index
  // `event_sync_events_teams_generated_pending_unique` makes it fully race-safe — two
  // concurrent posts cannot both enqueue a pending row. RETURNING id lets the caller
  // distinguish "inserted" (Some) from "skipped because a post is already pending" (None).
  const insertTeamsGeneratedEventQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      guild_id: Discord.Snowflake,
      event_id: Event.EventId,
      event_title: Schema.String,
      discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      teams_payload_json: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      INSERT INTO event_sync_events (
        team_id, guild_id, event_type, event_id, event_title, event_description,
        event_image_url, event_start_at, event_end_at, event_location,
        event_location_url, event_event_type, discord_target_channel_id,
        member_group_id, discord_role_id, claimed_by_member_id, claimed_by_display_name,
        event_all_day, teams_payload
      )
      SELECT
        ${input.team_id}, ${input.guild_id}, ${'teams_generated'}, ${input.event_id},
        ${input.event_title}, ${null},
        ${null}, ${DateTime.makeUnsafe(0)}, ${null}, ${null},
        ${null}, ${'teams_generated'}, ${input.discord_target_channel_id},
        ${null}, ${null}, ${null}, ${null}, ${false},
        ${input.teams_payload_json}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM event_sync_events
        WHERE event_type = 'teams_generated'
          AND event_id = ${input.event_id}
          AND processed_at IS NULL
      )
      ON CONFLICT (event_type, event_id)
        WHERE event_type = 'teams_generated' AND processed_at IS NULL
        DO NOTHING
      RETURNING id
    `,
  });

  /** Returns true if a new sync event was enqueued, false if a post was already pending. */
  const emitTeamsGenerated = (
    teamId: Team.TeamId,
    guildId: Discord.Snowflake,
    eventId: Event.EventId,
    title: string,
    discordTargetChannelId: Option.Option<Discord.Snowflake>,
    teams: ReadonlyArray<EventRpcEvents.TeamsGeneratedTeam>,
  ): Effect.Effect<boolean> =>
    insertTeamsGeneratedEventQuery({
      team_id: teamId,
      guild_id: guildId,
      event_id: eventId,
      event_title: title,
      discord_target_channel_id: discordTargetChannelId,
      teams_payload_json: JSON.stringify(teams),
    }).pipe(Effect.map(Option.isSome), catchSqlErrors);

  // ---- Roster event helpers ---------------------------------------------------

  const insertRosterEvent = SqlSchema.void({
    Request: RosterInsertInput,
    execute: (input) => sql`
      INSERT INTO event_sync_events (
        team_id, guild_id, event_type, event_id, event_title, event_description,
        event_image_url, event_start_at, event_end_at, event_location,
        event_location_url, event_event_type, discord_target_channel_id,
        member_group_id, discord_role_id, claimed_by_member_id, claimed_by_display_name,
        event_all_day
      ) VALUES (
        ${input.team_id}, ${input.guild_id}, ${input.event_type}, ${input.event_id},
        ${input.event_title}, ${input.event_description},
        ${null}, ${input.event_start_at}, ${null}, ${input.event_location},
        ${null}, ${'roster'}, ${input.discord_target_channel_id},
        ${input.member_group_id}, ${input.discord_role_id},
        ${input.claimed_by_member_id}, ${input.claimed_by_display_name}, ${false}
      )
    `,
  });

  /**
   * Emit an `event_roster_approval_request` outbox event.
   *
   * Column overloads (precedent: training-claim):
   *   discord_target_channel_id → event_roster_id
   *   member_group_id           → roster_id
   *   claimed_by_member_id      → team_member_id (candidate)
   *   claimed_by_display_name   → candidate_display_name (snapshot; COALESCE with u.name at read)
   *   event_location            → owners_thread_id
   *   discord_role_id           → owner_channel_id
   *   event_description         → roster_name
   *
   * Note: candidate discord_id is resolved at read time via the JOIN on claimed_by_member_id →
   * team_members → users.discord_id — no need to store it separately.
   */
  const emitEventRosterApprovalRequest = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    eventRosterId: EventRosterModel.EventRosterId,
    rosterId: RosterModel.RosterId,
    teamMemberId: TeamMember.TeamMemberId,
    candidateDisplayName: Option.Option<string>,
    title: string,
    startAt: DateTime.Utc,
    ownersThreadId: Option.Option<Discord.Snowflake>,
    ownerChannelId: Option.Option<Discord.Snowflake>,
    rosterName: Option.Option<string>,
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertRosterEvent({
              team_id: teamId,
              guild_id,
              event_type: 'event_roster_approval_request',
              event_id: eventId,
              event_title: title,
              event_description: rosterName,
              event_start_at: startAt,
              discord_target_channel_id: Option.some(eventRosterId),
              member_group_id: Option.some(rosterId),
              discord_role_id: ownerChannelId,
              claimed_by_member_id: Option.some(teamMemberId),
              claimed_by_display_name: candidateDisplayName,
              event_location: ownersThreadId,
            }),
        }),
      ),
      catchSqlErrors,
    );

  /**
   * Emit an `event_roster_approval_cancel` outbox event.
   *
   * Column overloads:
   *   event_location  → owners_thread_id
   *   discord_role_id → discord_message_id
   */
  const emitEventRosterApprovalCancel = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    ownersThreadId: Option.Option<Discord.Snowflake>,
    discordMessageId: Option.Option<Discord.Snowflake>,
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertRosterEvent({
              team_id: teamId,
              guild_id,
              event_type: 'event_roster_approval_cancel',
              event_id: eventId,
              event_title: '',
              event_description: Option.none(),
              event_start_at: DateTime.makeUnsafe(0),
              discord_target_channel_id: Option.none(),
              member_group_id: Option.none(),
              discord_role_id: discordMessageId,
              claimed_by_member_id: Option.none(),
              claimed_by_display_name: Option.none(),
              event_location: ownersThreadId,
            }),
        }),
      ),
      catchSqlErrors,
    );

  /**
   * Emit an `event_roster_thread_delete` outbox event.
   *
   * Column overloads:
   *   event_location → owners_thread_id
   */
  const emitEventRosterThreadDelete = (
    teamId: Team.TeamId,
    eventId: Event.EventId,
    ownersThreadId: Option.Option<Discord.Snowflake>,
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertRosterEvent({
              team_id: teamId,
              guild_id,
              event_type: 'event_roster_thread_delete',
              event_id: eventId,
              event_title: '',
              event_description: Option.none(),
              event_start_at: DateTime.makeUnsafe(0),
              discord_target_channel_id: Option.none(),
              member_group_id: Option.none(),
              discord_role_id: Option.none(),
              claimed_by_member_id: Option.none(),
              claimed_by_display_name: Option.none(),
              event_location: ownersThreadId,
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
    emitCoachingStatus,
    emitTeamsGenerated,
    emitEventRosterApprovalRequest,
    emitEventRosterApprovalCancel,
    emitEventRosterThreadDelete,
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
