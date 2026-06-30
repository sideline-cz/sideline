import {
  Discord,
  Event,
  EventRpcModels,
  EventSeries,
  GroupModel,
  Team,
  TeamMember,
  TrainingType,
} from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class EventWithDetails extends Schema.Class<EventWithDetails>('EventWithDetails')({
  id: Event.EventId,
  team_id: Team.TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
  event_type: Event.EventType,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  status: Event.EventStatus,
  created_by: TeamMember.TeamMemberId,
  training_type_name: Schema.OptionFromNullOr(Schema.String),
  created_by_name: Schema.OptionFromNullOr(Schema.String),
  series_id: Schema.OptionFromNullOr(EventSeries.EventSeriesId),
  series_modified: Schema.Boolean,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  owner_group_name: Schema.OptionFromNullOr(Schema.String),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_name: Schema.OptionFromNullOr(Schema.String),
  reminder_sent_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  claimed_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  claimer_name: Schema.OptionFromNullOr(Schema.String),
  claim_discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claim_discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  all_day: Schema.Boolean,
  personal_messages_dirty_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

class EventRow extends Schema.Class<EventRow>('EventRow')({
  id: Event.EventId,
  team_id: Team.TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
  event_type: Event.EventType,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  status: Event.EventStatus,
  created_by: TeamMember.TeamMemberId,
  series_id: Schema.OptionFromNullOr(EventSeries.EventSeriesId),
  series_modified: Schema.Boolean,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  all_day: Schema.Boolean,
}) {}

const EventInsertInput = Schema.Struct({
  team_id: Schema.String,
  training_type_id: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  created_by: Schema.String,
  series_id: Schema.OptionFromNullOr(Schema.String),
  owner_group_id: Schema.OptionFromNullOr(Schema.String),
  member_group_id: Schema.OptionFromNullOr(Schema.String),
  all_day: Schema.Boolean,
});
// Note: discord_target_channel_id was removed (migration 1790300009)

const EventUpdateInput = Schema.Struct({
  id: Event.EventId,
  title: Schema.String,
  event_type: Schema.String,
  training_type_id: Schema.OptionFromNullOr(Schema.String),
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  owner_group_id: Schema.OptionFromNullOr(Schema.String),
  member_group_id: Schema.OptionFromNullOr(Schema.String),
  all_day: Schema.Boolean,
});

class ScopedTrainingTypeId extends Schema.Class<ScopedTrainingTypeId>('ScopedTrainingTypeId')({
  training_type_id: TrainingType.TrainingTypeId,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: EventWithDetails,
    execute: (teamId) => sql`
            SELECT e.id, e.team_id, e.training_type_id, e.event_type, e.title,
                   e.description, e.image_url, e.start_at, e.end_at,
                   e.location, e.location_url, e.status, e.created_by,
                   tt.name AS training_type_name,
                   u.name AS created_by_name,
                   e.series_id, e.series_modified,
                   e.owner_group_id, og.name AS owner_group_name,
                   e.member_group_id, mg.name AS member_group_name,
                   e.reminder_sent_at,
                   e.claimed_by,
                   cu.name AS claimer_name,
                   e.claim_discord_channel_id,
                   e.claim_discord_message_id,
                   e.all_day,
                   e.personal_messages_dirty_at
            FROM events e
            LEFT JOIN training_types tt ON tt.id = e.training_type_id
            LEFT JOIN team_members tm ON tm.id = e.created_by
            LEFT JOIN users u ON u.id = tm.user_id
            LEFT JOIN groups og ON og.id = e.owner_group_id
            LEFT JOIN groups mg ON mg.id = e.member_group_id
            LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
            LEFT JOIN users cu ON cu.id = ctm.user_id
            WHERE e.team_id = ${teamId}
            ORDER BY e.start_at ASC
          `,
  });

  const findByIdWithDetails = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: EventWithDetails,
    execute: (id) => sql`
            SELECT e.id, e.team_id, e.training_type_id, e.event_type, e.title,
                   e.description, e.image_url, e.start_at, e.end_at,
                   e.location, e.location_url, e.status, e.created_by,
                   tt.name AS training_type_name,
                   u.name AS created_by_name,
                   e.series_id, e.series_modified,
                   e.owner_group_id, og.name AS owner_group_name,
                   e.member_group_id, mg.name AS member_group_name,
                   e.reminder_sent_at,
                   e.claimed_by,
                   cu.name AS claimer_name,
                   e.claim_discord_channel_id,
                   e.claim_discord_message_id,
                   e.all_day,
                   e.personal_messages_dirty_at
            FROM events e
            LEFT JOIN training_types tt ON tt.id = e.training_type_id
            LEFT JOIN team_members tm ON tm.id = e.created_by
            LEFT JOIN users u ON u.id = tm.user_id
            LEFT JOIN groups og ON og.id = e.owner_group_id
            LEFT JOIN groups mg ON mg.id = e.member_group_id
            LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
            LEFT JOIN users cu ON cu.id = ctm.user_id
            WHERE e.id = ${id}
          `,
  });

  const insert = SqlSchema.findOne({
    Request: EventInsertInput,
    Result: EventRow,
    execute: (input) => sql`
            INSERT INTO events (team_id, training_type_id, event_type, title, description,
                                image_url, start_at, end_at, location, location_url, created_by, series_id,
                                owner_group_id, member_group_id, all_day)
            VALUES (${input.team_id}, ${input.training_type_id}, ${input.event_type},
                    ${input.title}, ${input.description}, ${input.image_url}, ${input.start_at},
                    ${input.end_at}, ${input.location}, ${input.location_url}, ${input.created_by},
                    ${input.series_id},
                    ${input.owner_group_id}, ${input.member_group_id}, ${input.all_day})
            RETURNING id, team_id, training_type_id, event_type, title, description,
                      image_url, start_at, end_at, location, location_url, status,
                      created_by, series_id, series_modified,
                      owner_group_id, member_group_id, all_day
          `,
  });

  const update = SqlSchema.findOne({
    Request: EventUpdateInput,
    Result: EventRow,
    execute: (input) => sql`
            UPDATE events SET
              title = ${input.title},
              event_type = ${input.event_type},
              training_type_id = ${input.training_type_id},
              description = ${input.description},
              image_url = ${input.image_url},
              start_at = ${input.start_at},
              end_at = ${input.end_at},
              location = ${input.location},
              location_url = ${input.location_url},
              owner_group_id = ${input.owner_group_id},
              member_group_id = ${input.member_group_id},
              all_day = ${input.all_day},
              updated_at = now()
            WHERE id = ${input.id}
            RETURNING id, team_id, training_type_id, event_type, title, description,
                      image_url, start_at, end_at, location, location_url, status,
                      created_by, series_id, series_modified,
                      owner_group_id, member_group_id, all_day
          `,
  });

  const cancel = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) =>
      sql`UPDATE events SET status = 'cancelled', updated_at = now() WHERE id = ${id}`,
  });

  const start = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (id) =>
      sql`UPDATE events SET status = 'started', updated_at = now() WHERE id = ${id} AND status = 'active' RETURNING id`,
  });

  const findStartable = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: Event.EventId,
      team_id: Team.TeamId,
      title: Schema.String,
      description: Schema.OptionFromNullOr(Schema.String),
      image_url: Schema.OptionFromNullOr(Schema.String),
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      event_type: Schema.String,
      member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
      owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
      reminders_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      all_day: Schema.Boolean,
      claimed_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
    }),
    execute: () => sql`
      SELECT e.id, e.team_id, e.title, e.description, e.image_url, e.start_at, e.end_at, e.location, e.location_url, e.event_type,
             e.member_group_id, e.owner_group_id,
             ts.reminders_channel_id, e.all_day, e.claimed_by
      FROM events e
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.status = 'active'
        AND e.start_at <= NOW()
    `,
  });

  const findScopedTrainingTypeIds = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: ScopedTrainingTypeId,
    execute: (teamMemberId) => sql`
            SELECT DISTINCT rtt.training_type_id FROM (
              SELECT rtt.training_type_id
              FROM member_roles mr
              JOIN role_training_types rtt ON rtt.role_id = mr.role_id
              WHERE mr.team_member_id = ${teamMemberId}
              UNION ALL
              SELECT rtt.training_type_id
              FROM group_members gm
              JOIN LATERAL (
                WITH RECURSIVE ancestors AS (
                  SELECT gm.group_id AS id
                  UNION ALL
                  SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                )
                SELECT id FROM ancestors
              ) anc ON true
              JOIN role_groups rg ON rg.group_id = anc.id
              JOIN role_training_types rtt ON rtt.role_id = rg.role_id
              WHERE gm.team_member_id = ${teamMemberId}
            ) rtt
          `,
  });

  const saveDiscordMessage = SqlSchema.void({
    Request: Schema.Struct({
      event_id: Event.EventId,
      discord_channel_id: Discord.Snowflake,
      discord_message_id: Discord.Snowflake,
    }),
    execute: (input) =>
      sql`UPDATE events SET discord_channel_id = ${input.discord_channel_id}, discord_message_id = ${input.discord_message_id} WHERE id = ${input.event_id}`,
  });

  const getDiscordMessage = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({
      discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    execute: (id) =>
      sql`SELECT discord_channel_id, discord_message_id FROM events WHERE id = ${id}`,
  });

  const findChannelsWithStoredMessages = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      discord_channel_id: Discord.Snowflake,
      guild_id: Discord.Snowflake,
    }),
    execute: () => sql`
      SELECT DISTINCT e.discord_channel_id, t.guild_id
      FROM events e
      JOIN teams t ON t.id = e.team_id
      WHERE e.discord_channel_id IS NOT NULL
        AND e.discord_message_id IS NOT NULL
        AND t.guild_id IS NOT NULL
    `,
  });

  const findByChannelId = SqlSchema.findAll({
    Request: Discord.Snowflake,
    Result: Schema.Struct({
      event_id: Schema.String,
      team_id: Schema.String,
      title: Schema.String,
      description: Schema.OptionFromNullOr(Schema.String),
      image_url: Schema.OptionFromNullOr(Schema.String),
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      event_type: Schema.String,
      status: Schema.String,
      discord_message_id: Discord.Snowflake,
      all_day: Schema.Boolean,
    }),
    execute: (channelId) => sql`
            SELECT id AS event_id, team_id, title, description, image_url,
                   start_at, end_at, location, location_url, event_type,
                   status, discord_message_id, all_day
            FROM events
            WHERE discord_channel_id = ${channelId}
              AND discord_message_id IS NOT NULL
            ORDER BY start_at ASC
          `,
  });

  const markReminder = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) => sql`UPDATE events SET reminder_sent_at = now() WHERE id = ${id}`,
  });

  const markAutoLogged = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) => sql`UPDATE events SET auto_logged_at = now() WHERE id = ${id}`,
  });

  const _claimTraining = SqlSchema.findOneOption({
    Request: Schema.Struct({ event_id: Event.EventId, team_member_id: TeamMember.TeamMemberId }),
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (input) =>
      sql`UPDATE events SET claimed_by = ${input.team_member_id} WHERE id = ${input.event_id} AND status = 'active' AND event_type = 'training' AND claimed_by IS NULL RETURNING id`,
  });

  const _unclaimTraining = SqlSchema.findOneOption({
    Request: Schema.Struct({ event_id: Event.EventId, team_member_id: TeamMember.TeamMemberId }),
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (input) =>
      sql`UPDATE events SET claimed_by = NULL WHERE id = ${input.event_id} AND status = 'active' AND claimed_by = ${input.team_member_id} RETURNING id`,
  });

  const _saveClaimDiscordMessage = SqlSchema.void({
    Request: Schema.Struct({
      event_id: Event.EventId,
      channel_id: Schema.String,
      message_id: Schema.String,
    }),
    execute: (input) =>
      sql`UPDATE events SET claim_discord_channel_id = ${input.channel_id}, claim_discord_message_id = ${input.message_id} WHERE id = ${input.event_id}`,
  });

  const _saveClaimThreadId = SqlSchema.void({
    Request: Schema.Struct({
      event_id: Event.EventId,
      thread_id: Discord.Snowflake,
    }),
    execute: (input) =>
      sql`UPDATE events SET claim_thread_id = ${input.thread_id} WHERE id = ${input.event_id}`,
  });

  const _markClaimRequestSent = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) => sql`UPDATE events SET claim_request_sent_at = now() WHERE id = ${id}`,
  });

  const _markCoachingStatusSent = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) => sql`UPDATE events SET coaching_status_sent_at = now() WHERE id = ${id}`,
  });

  const _findClaimInfo = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({
      event_id: Event.EventId,
      event_type: Schema.String,
      status: Schema.String,
      claimed_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
      claimer_name: Schema.OptionFromNullOr(Schema.String),
      claim_discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      claim_discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
      claim_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    execute: (id) => sql`
      SELECT e.id AS event_id, e.event_type, e.status,
             e.claimed_by, cu.name AS claimer_name,
             e.claim_discord_channel_id, e.claim_discord_message_id,
             e.claim_thread_id
      FROM events e
      LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
      LEFT JOIN users cu ON cu.id = ctm.user_id
      WHERE e.id = ${id}
    `,
  });

  const findEndedTrainings = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: Event.EventId,
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    }),
    execute: () => sql`
      SELECT id, start_at, end_at
      FROM events
      WHERE event_type = 'training'
        AND status IN ('active', 'started')
        AND auto_logged_at IS NULL
        AND COALESCE(end_at, start_at) < NOW()
        AND COALESCE(end_at, start_at) > NOW() - INTERVAL '7 days'
    `,
  });

  const findUpcomingForDashboard = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Schema.String,
      team_member_id: Schema.String,
    }),
    Result: Schema.Struct({
      id: Event.EventId,
      title: Schema.String,
      event_type: Event.EventType,
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
      my_rsvp: Schema.OptionFromNullOr(Schema.String),
      all_day: Schema.Boolean,
    }),
    execute: (input) => sql`
      SELECT e.id, e.title, e.event_type, e.start_at, e.end_at,
             e.location, e.location_url, e.member_group_id, e.all_day,
             er.response AS my_rsvp
      FROM events e
      LEFT JOIN event_rsvps er ON er.event_id = e.id AND er.team_member_id = ${input.team_member_id}
      WHERE e.team_id = ${input.team_id}
        AND e.status = 'active'
        AND e.start_at >= now()
      ORDER BY e.start_at ASC
    `,
  });

  const markModified = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) =>
      sql`UPDATE events SET series_modified = true, updated_at = now() WHERE id = ${id}`,
  });

  const cancelFuture = SqlSchema.void({
    Request: Schema.Struct({
      series_id: Schema.String,
      from_date: Schema.Date,
    }),
    execute: (input) =>
      sql`UPDATE events SET status = 'cancelled', updated_at = now()
              WHERE series_id = ${input.series_id}
                AND (start_at AT TIME ZONE 'UTC')::date >= ${input.from_date}::date
                AND status = 'active'`,
  });

  const updateFutureUnmodified = SqlSchema.void({
    Request: Schema.Struct({
      series_id: Schema.String,
      from_date: Schema.Date,
      title: Schema.String,
      training_type_id: Schema.OptionFromNullOr(Schema.String),
      description: Schema.OptionFromNullOr(Schema.String),
      start_time: Schema.String,
      end_time: Schema.OptionFromNullOr(Schema.String),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) =>
      sql`UPDATE events SET
                title = ${input.title},
                training_type_id = ${input.training_type_id},
                description = ${input.description},
                start_at = ((start_at AT TIME ZONE 'UTC')::date + ${input.start_time}::time) AT TIME ZONE 'UTC',
                end_at = CASE WHEN ${input.end_time}::time IS NOT NULL THEN ((start_at AT TIME ZONE 'UTC')::date + ${input.end_time}::time) AT TIME ZONE 'UTC' ELSE NULL END,
                location = ${input.location},
                location_url = ${input.location_url},
                updated_at = now()
              WHERE series_id = ${input.series_id}
                AND (start_at AT TIME ZONE 'UTC')::date >= ${input.from_date}::date
                AND series_modified = false
                AND status = 'active'`,
  });

  const findUpcomingByGuild = SqlSchema.findAll({
    Request: Schema.Struct({
      guild_id: Schema.String,
      offset: Schema.Number,
      limit: Schema.Number,
    }),
    Result: Schema.Struct({
      event_id: Schema.String,
      title: Schema.String,
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      event_type: Schema.String,
      yes_count: Schema.Number,
      no_count: Schema.Number,
      maybe_count: Schema.Number,
      all_day: Schema.Boolean,
    }),
    execute: (input) => sql`
            SELECT e.id AS event_id, e.title, e.start_at, e.end_at,
                   e.location, e.location_url, e.event_type, e.all_day,
                   COALESCE(SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END), 0)::int AS yes_count,
                   COALESCE(SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END), 0)::int AS no_count,
                   COALESCE(SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END), 0)::int AS maybe_count
            FROM events e
            LEFT JOIN event_rsvps er ON er.event_id = e.id
            WHERE e.team_id = (SELECT id FROM teams WHERE guild_id = ${input.guild_id})
              AND e.status = 'active'
              AND e.start_at >= now()
            GROUP BY e.id
            ORDER BY e.start_at ASC
            LIMIT ${input.limit} OFFSET ${input.offset}
          `,
  });

  const findLoggableTrainingsByGuild = SqlSchema.findAll({
    Request: Schema.Struct({ guild_id: Schema.String }),
    Result: Schema.Struct({
      event_id: Schema.String,
      title: Schema.String,
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      event_type: Schema.String,
      yes_count: Schema.Number,
      no_count: Schema.Number,
      maybe_count: Schema.Number,
      all_day: Schema.Boolean,
    }),
    execute: (input) => sql`
            SELECT e.id AS event_id, e.title, e.start_at, e.end_at,
                   e.location, e.location_url, e.event_type, e.all_day,
                   COALESCE(SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END), 0)::int AS yes_count,
                   COALESCE(SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END), 0)::int AS no_count,
                   COALESCE(SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END), 0)::int AS maybe_count
            FROM events e
            LEFT JOIN event_rsvps er ON er.event_id = e.id
            WHERE e.team_id = (SELECT id FROM teams WHERE guild_id = ${input.guild_id})
              AND e.event_type = 'training'
              AND e.status IN ('active', 'started')
              AND e.start_at >= now() - interval '2 days'
            GROUP BY e.id
            ORDER BY e.start_at DESC
            LIMIT 25
          `,
  });

  const findByUserId = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.OptionFromNullOr(Schema.String),
      image_url: Schema.OptionFromNullOr(Schema.String),
      start_at: Schemas.DateTimeFromDate,
      end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      status: Schema.String,
      event_type: Schema.String,
      team_name: Schema.String,
      rsvp_response: Schema.String,
      all_day: Schema.Boolean,
    }),
    execute: (userId) => sql`
            SELECT e.id, e.title, e.description, e.image_url, e.start_at, e.end_at,
                   e.location, e.location_url, e.status, e.event_type, t.name AS team_name,
                   er.response AS rsvp_response, e.all_day
            FROM events e
            JOIN teams t ON t.id = e.team_id
            JOIN team_members tm ON tm.team_id = t.id AND tm.active = true
            JOIN event_rsvps er ON er.event_id = e.id AND er.team_member_id = tm.id
            WHERE tm.user_id = ${userId}
              AND e.status IN ('active', 'started')
              AND er.response IN ('yes', 'maybe')
            ORDER BY e.start_at ASC
          `,
  });

  const countUpcomingByGuild = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (guildId) => sql`
            SELECT COUNT(*)::int AS count
            FROM events
            WHERE team_id = (SELECT id FROM teams WHERE guild_id = ${guildId})
              AND status = 'active'
              AND start_at >= now()
          `,
  });

  const findUpcomingByGuildId = (guildId: Discord.Snowflake, offset: number, limit: number) =>
    findUpcomingByGuild({ guild_id: guildId, offset, limit }).pipe(catchSqlErrors);

  const countUpcomingByGuildId = (guildId: Discord.Snowflake) =>
    countUpcomingByGuild(guildId).pipe(
      Effect.map(Option.map((r) => r.count)),
      Effect.map(Option.getOrElse(() => 0)),
      catchSqlErrors,
    );

  const findLoggableTrainingsByGuildId = (guildId: Discord.Snowflake) =>
    findLoggableTrainingsByGuild({ guild_id: guildId }).pipe(catchSqlErrors);

  const findEventsByUserId = (userId: string) => findByUserId(userId).pipe(catchSqlErrors);

  const findEventsByTeamId = (teamId: Team.TeamId) => findByTeamId(teamId).pipe(catchSqlErrors);

  const findEventByIdWithDetails = (eventId: Event.EventId) =>
    findByIdWithDetails(eventId).pipe(catchSqlErrors);

  const insertEvent = ({
    teamId,
    trainingTypeId,
    eventType,
    title,
    description,
    imageUrl = Option.none(),
    startAt,
    endAt,
    location,
    locationUrl = Option.none(),
    createdBy,
    seriesId = Option.none(),
    ownerGroupId = Option.none(),
    memberGroupId = Option.none(),
    allDay = false,
  }: {
    teamId: Team.TeamId;
    trainingTypeId: Option.Option<string>;
    eventType: string;
    title: string;
    description: Option.Option<string>;
    imageUrl?: Option.Option<string>;
    startAt: DateTime.Utc;
    endAt: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    createdBy: TeamMember.TeamMemberId;
    seriesId?: Option.Option<string>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
    allDay?: boolean;
  }) =>
    insert({
      team_id: teamId,
      training_type_id: trainingTypeId,
      event_type: eventType,
      title,
      description,
      image_url: imageUrl,
      start_at: startAt,
      end_at: endAt,
      location,
      location_url: locationUrl,
      created_by: createdBy,
      series_id: seriesId,
      owner_group_id: ownerGroupId,
      member_group_id: memberGroupId,
      all_day: allDay,
    }).pipe(catchSqlErrors);

  const updateEvent = ({
    id,
    title,
    eventType,
    trainingTypeId,
    description,
    imageUrl = Option.none(),
    startAt,
    endAt,
    location,
    locationUrl = Option.none(),
    ownerGroupId = Option.none(),
    memberGroupId = Option.none(),
    allDay = false,
  }: {
    id: Event.EventId;
    title: string;
    eventType: string;
    trainingTypeId: Option.Option<string>;
    description: Option.Option<string>;
    imageUrl?: Option.Option<string>;
    startAt: DateTime.Utc;
    endAt: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
    allDay?: boolean;
  }) =>
    update({
      id,
      title,
      event_type: eventType,
      training_type_id: trainingTypeId,
      description,
      image_url: imageUrl,
      start_at: startAt,
      end_at: endAt,
      location,
      location_url: locationUrl,
      owner_group_id: ownerGroupId,
      member_group_id: memberGroupId,
      all_day: allDay,
    }).pipe(catchSqlErrors);

  const cancelEvent = (eventId: Event.EventId) => cancel(eventId).pipe(catchSqlErrors);

  const startEvent = (eventId: Event.EventId) => start(eventId).pipe(catchSqlErrors);

  const findEventsToStart = () => findStartable(undefined).pipe(catchSqlErrors);

  const getScopedTrainingTypeIds = (teamMemberId: TeamMember.TeamMemberId) =>
    findScopedTrainingTypeIds(teamMemberId).pipe(catchSqlErrors);

  const saveDiscordMessageId = (
    eventId: Event.EventId,
    channelId: Discord.Snowflake,
    messageId: Discord.Snowflake,
  ) =>
    saveDiscordMessage({
      event_id: eventId,
      discord_channel_id: channelId,
      discord_message_id: messageId,
    }).pipe(catchSqlErrors);

  const getDiscordMessageId = (eventId: Event.EventId) =>
    getDiscordMessage(eventId).pipe(catchSqlErrors);

  const findEventsByChannelId = (channelId: Discord.Snowflake) =>
    findByChannelId(channelId).pipe(catchSqlErrors);

  const findAllChannelsWithStoredMessages = () =>
    findChannelsWithStoredMessages(undefined).pipe(catchSqlErrors);

  const markReminderSent = (eventId: Event.EventId) => markReminder(eventId).pipe(catchSqlErrors);

  const markTrainingAutoLogged = (eventId: Event.EventId) =>
    markAutoLogged(eventId).pipe(catchSqlErrors);

  const claimTraining = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
    _claimTraining({ event_id: eventId, team_member_id: memberId }).pipe(catchSqlErrors);

  const unclaimTraining = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
    _unclaimTraining({ event_id: eventId, team_member_id: memberId }).pipe(catchSqlErrors);

  const saveClaimDiscordMessage = (eventId: Event.EventId, channelId: string, messageId: string) =>
    _saveClaimDiscordMessage({
      event_id: eventId,
      channel_id: channelId,
      message_id: messageId,
    }).pipe(catchSqlErrors);

  const saveClaimThread = (eventId: Event.EventId, threadId: Discord.Snowflake) =>
    _saveClaimThreadId({
      event_id: eventId,
      thread_id: threadId,
    }).pipe(catchSqlErrors);

  const markClaimRequestSent = (eventId: Event.EventId) =>
    _markClaimRequestSent(eventId).pipe(catchSqlErrors);

  const markCoachingStatusSent = (eventId: Event.EventId) =>
    _markCoachingStatusSent(eventId).pipe(catchSqlErrors);

  const findClaimInfo = (eventId: Event.EventId) =>
    _findClaimInfo(eventId).pipe(
      Effect.map(
        Option.map(
          (row) =>
            new EventRpcModels.EventClaimInfo({
              event_id: row.event_id,
              event_type: row.event_type,
              status: row.status,
              claimed_by_member_id: row.claimed_by,
              claimed_by_display_name: row.claimer_name,
              claim_discord_channel_id: row.claim_discord_channel_id,
              claim_discord_message_id: row.claim_discord_message_id,
              claim_thread_id: row.claim_thread_id,
            }),
        ),
      ),
      catchSqlErrors,
    );

  const findEndedTrainingsForAutoLog = () => findEndedTrainings(undefined).pipe(catchSqlErrors);

  const markEventSeriesModified = (eventId: Event.EventId) =>
    markModified(eventId).pipe(catchSqlErrors);

  const cancelFutureInSeries = (seriesId: EventSeries.EventSeriesId, fromDate: Date) =>
    cancelFuture({ series_id: seriesId, from_date: fromDate }).pipe(catchSqlErrors);

  const findUpcomingWithRsvp = (teamId: Team.TeamId, teamMemberId: TeamMember.TeamMemberId) =>
    findUpcomingForDashboard({ team_id: teamId, team_member_id: teamMemberId }).pipe(
      catchSqlErrors,
    );

  const markPersonalMessagesDirty = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) =>
      sql`UPDATE events SET personal_messages_dirty_at = date_trunc('milliseconds', now()) WHERE id = ${id}`,
  });

  const clearPersonalMessagesDirty = SqlSchema.void({
    Request: Schema.Struct({ id: Event.EventId, dirty_at: Schema.Date }),
    execute: (input) =>
      sql`UPDATE events SET personal_messages_dirty_at = NULL WHERE id = ${input.id} AND personal_messages_dirty_at = ${input.dirty_at}`,
  });

  // Mark every active, upcoming event for a team dirty so the personal-events
  // reconcile loop (re)builds personal messages — e.g. to populate a member's
  // freshly-provisioned channel with their existing events. Only touches events
  // that are not already dirty, so in-flight reconciles are left undisturbed.
  const markTeamUpcomingPersonalMessagesDirty = SqlSchema.void({
    Request: Team.TeamId,
    execute: (teamId) =>
      sql`UPDATE events SET personal_messages_dirty_at = date_trunc('milliseconds', now())
          WHERE team_id = ${teamId}
            AND status = 'active'
            AND start_at >= now()
            AND personal_messages_dirty_at IS NULL`,
  });

  const markSeriesFuturePersonalMessagesDirtySchema = SqlSchema.void({
    Request: Schema.Struct({
      series_id: Schema.String,
      from_date: Schema.Date,
    }),
    execute: (input) =>
      sql`UPDATE events SET personal_messages_dirty_at = date_trunc('milliseconds', now())
          WHERE series_id = ${input.series_id}
            AND (start_at AT TIME ZONE 'UTC')::date >= ${input.from_date}::date`,
  });

  const updateFutureUnmodifiedInSeries = (
    seriesId: EventSeries.EventSeriesId,
    fromDate: Date,
    fields: {
      title: string;
      trainingTypeId: Option.Option<string>;
      description: Option.Option<string>;
      startTime: string;
      endTime: Option.Option<string>;
      location: Option.Option<string>;
      locationUrl: Option.Option<string>;
    },
  ) =>
    updateFutureUnmodified({
      series_id: seriesId,
      from_date: fromDate,
      title: fields.title,
      training_type_id: fields.trainingTypeId,
      description: fields.description,
      start_time: fields.startTime,
      end_time: fields.endTime,
      location: fields.location,
      location_url: fields.locationUrl,
    }).pipe(catchSqlErrors);

  const markEventPersonalMessagesDirty = (eventId: Event.EventId) =>
    markPersonalMessagesDirty(eventId).pipe(catchSqlErrors);

  const markTeamUpcomingEventsPersonalMessagesDirty = (teamId: Team.TeamId) =>
    markTeamUpcomingPersonalMessagesDirty(teamId).pipe(catchSqlErrors);

  const markSeriesFuturePersonalMessagesDirty = (
    seriesId: EventSeries.EventSeriesId,
    fromDate: Date,
  ) =>
    markSeriesFuturePersonalMessagesDirtySchema({
      series_id: seriesId,
      from_date: fromDate,
    }).pipe(catchSqlErrors);

  const clearEventPersonalMessagesDirty = (eventId: Event.EventId, observedDirtyAt: DateTime.Utc) =>
    clearPersonalMessagesDirty({
      id: eventId,
      dirty_at: new Date(observedDirtyAt.epochMilliseconds),
    }).pipe(catchSqlErrors);

  return {
    findUpcomingByGuildId,
    countUpcomingByGuildId,
    findLoggableTrainingsByGuildId,
    findEventsByUserId,
    findEventsByTeamId,
    findEventByIdWithDetails,
    insertEvent,
    updateEvent,
    cancelEvent,
    startEvent,
    findEventsToStart,
    getScopedTrainingTypeIds,
    saveDiscordMessageId,
    getDiscordMessageId,
    findEventsByChannelId,
    findAllChannelsWithStoredMessages,
    markReminderSent,
    markClaimRequestSent,
    markCoachingStatusSent,
    markTrainingAutoLogged,
    findEndedTrainingsForAutoLog,
    markEventSeriesModified,
    cancelFutureInSeries,
    findUpcomingWithRsvp,
    updateFutureUnmodifiedInSeries,
    claimTraining,
    unclaimTraining,
    saveClaimDiscordMessage,
    saveClaimThread,
    findClaimInfo,
    markEventPersonalMessagesDirty,
    markTeamUpcomingEventsPersonalMessagesDirty,
    markSeriesFuturePersonalMessagesDirty,
    clearEventPersonalMessagesDirty,
  };
});

export class EventsRepository extends ServiceMap.Service<
  EventsRepository,
  Effect.Success<typeof make>
>()('api/EventsRepository') {
  static readonly Default = Layer.effect(EventsRepository, make);
}
