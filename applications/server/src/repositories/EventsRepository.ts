import {
  Discord,
  Event,
  EventRpcModels,
  EventRsvp,
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
import {
  eventDayOrder,
  eventEndOfLastLocalDay,
  eventNotVisibleNow,
  eventVisibleNow,
} from '~/repositories/eventVisibility.js';

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
  // Derived team-local calendar date (plan §11.2/§11.3), projected in SQL from
  // `start_at`/`end_at` and the team's timezone. Always present — this is the
  // server's own row, decoded from its own query, not a wire field — so it is a
  // plain `Schema.String`, not `OptionFromOptionalKey`. The `::date::text` cast in
  // the query is mandatory: a bare `::date` comes back as a JS `Date`, which this
  // schema would reject.
  start_date: Schema.String,
  end_date: Schema.String,
  // The team's own timezone, `COALESCE`d against the same `'Europe/Prague'`
  // fallback used everywhere else (plan §4.5). `EventWithDetails` is the
  // `Result` of BOTH `findByIdWithDetails` and `findByTeamId` — both queries
  // MUST select it, or the query missing it fails schema decode entirely.
  // Consumed by `allDayRsvpWindow.ts#eventAcceptsRsvp` so every RSVP call site
  // gets the team's timezone for free instead of a second lookup.
  timezone: Schema.String,
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
  // See `EventWithDetails.start_date` above — same derived projection (plan §11.2/§11.3).
  start_date: Schema.String,
  end_date: Schema.String,
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
                   e.personal_messages_dirty_at,
                   (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS start_date,
                   (COALESCE(e.end_at, e.start_at)
                       AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS end_date,
                   COALESCE(ts.timezone, 'Europe/Prague') AS timezone
            FROM events e
            LEFT JOIN training_types tt ON tt.id = e.training_type_id
            LEFT JOIN team_members tm ON tm.id = e.created_by
            LEFT JOIN users u ON u.id = tm.user_id
            LEFT JOIN groups og ON og.id = e.owner_group_id
            LEFT JOIN groups mg ON mg.id = e.member_group_id
            LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
            LEFT JOIN users cu ON cu.id = ctm.user_id
            LEFT JOIN team_settings ts ON ts.team_id = e.team_id
            WHERE e.team_id = ${teamId}
            ORDER BY ${sql.unsafe(eventDayOrder('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
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
                   e.personal_messages_dirty_at,
                   (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS start_date,
                   (COALESCE(e.end_at, e.start_at)
                       AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS end_date,
                   COALESCE(ts.timezone, 'Europe/Prague') AS timezone
            FROM events e
            LEFT JOIN training_types tt ON tt.id = e.training_type_id
            LEFT JOIN team_members tm ON tm.id = e.created_by
            LEFT JOIN users u ON u.id = tm.user_id
            LEFT JOIN groups og ON og.id = e.owner_group_id
            LEFT JOIN groups mg ON mg.id = e.member_group_id
            LEFT JOIN team_members ctm ON ctm.id = e.claimed_by
            LEFT JOIN users cu ON cu.id = ctm.user_id
            LEFT JOIN team_settings ts ON ts.team_id = e.team_id
            WHERE e.id = ${id}
          `,
  });

  const insert = SqlSchema.findOne({
    Request: EventInsertInput,
    Result: EventRow,
    execute: (input) => sql`
            WITH inserted AS (
              INSERT INTO events (team_id, training_type_id, event_type, title, description,
                                  image_url, start_at, end_at, location, location_url, created_by, series_id,
                                  owner_group_id, member_group_id, all_day, all_day_anchored)
              VALUES (${input.team_id}, ${input.training_type_id}, ${input.event_type},
                      ${input.title}, ${input.description}, ${input.image_url}, ${input.start_at},
                      ${input.end_at}, ${input.location}, ${input.location_url}, ${input.created_by},
                      ${input.series_id},
                      ${input.owner_group_id}, ${input.member_group_id}, ${input.all_day},
                      ${input.all_day})
              RETURNING id, team_id, training_type_id, event_type, title, description,
                        image_url, start_at, end_at, location, location_url, status,
                        created_by, series_id, series_modified,
                        owner_group_id, member_group_id, all_day
            )
            SELECT inserted.*,
                   (inserted.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS start_date,
                   (COALESCE(inserted.end_at, inserted.start_at)
                       AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS end_date
            FROM inserted
            LEFT JOIN team_settings ts ON ts.team_id = inserted.team_id
          `,
  });

  const update = SqlSchema.findOne({
    Request: EventUpdateInput,
    Result: EventRow,
    execute: (input) => sql`
            WITH updated AS (
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
                all_day_anchored = ${input.all_day},
                updated_at = now()
              WHERE id = ${input.id}
              RETURNING id, team_id, training_type_id, event_type, title, description,
                        image_url, start_at, end_at, location, location_url, status,
                        created_by, series_id, series_modified,
                        owner_group_id, member_group_id, all_day
            )
            SELECT updated.*,
                   (updated.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS start_date,
                   (COALESCE(updated.end_at, updated.start_at)
                       AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                       AS end_date
            FROM updated
            LEFT JOIN team_settings ts ON ts.team_id = updated.team_id
          `,
  });

  const cancel = SqlSchema.void({
    Request: Event.EventId,
    execute: (id) =>
      sql`UPDATE events SET status = 'cancelled', updated_at = now() WHERE id = ${id}`,
  });

  // The flip ARMS both deferred sweeps atomically, in the same statement
  // (plan §4.8.1/§15.2): a timed event is stamped `now()` immediately (its
  // increment/emit happen this same cron cycle, so both stamps must already
  // read "done"); an all-day event is left `NULL` ("armed"), so the deferred
  // missed-RSVP sweep and the deferred "Dnes" post sweep both know to pick it
  // up later. Because "armed" (`NULL`) is written ONLY by this statement,
  // a flip performed by OLD code (a rolling deploy, or a revert to
  // pre-migration code) can never leave a row in the armed state — the
  // migration's unconditional backfill already disarmed every pre-existing
  // row, and old code's flip never re-arms it. No version detection needed.
  const start = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (id) =>
      sql`
        UPDATE events
        SET status = 'started',
            updated_at = now(),
            missed_rsvp_counted_at = CASE WHEN all_day THEN NULL ELSE now() END,
            all_day_post_sent_at   = CASE WHEN all_day THEN NULL ELSE now() END
        WHERE id = ${id} AND status = 'active'
        RETURNING id
      `,
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

  // The deferred missed-RSVP sweep (plan §4.8.2/§14.4): all-day events that
  // are `started` and whose last local day has passed, but whose counter is
  // still armed (`NULL`). `LEFT JOIN team_settings` + `COALESCE` is required,
  // not optional — an INNER join would silently skip every event of a team
  // with no `team_settings` row (§4.4.4). The `INTERVAL '7 days'` lower bound
  // mirrors `findEndedTrainings`.
  const findAllDayEventsPastLastLocalDayStmt = (nowParam: string) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        id: Event.EventId,
        team_id: Team.TeamId,
        member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
      }),
      execute: () => sql`
        SELECT e.id, e.team_id, e.member_group_id
        FROM events e
        LEFT JOIN team_settings ts ON ts.team_id = e.team_id
        WHERE e.all_day = TRUE
          AND e.status = 'started'
          AND e.missed_rsvp_counted_at IS NULL
          AND (COALESCE(e.end_at, e.start_at) AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date
              < ((${nowParam}::timestamptz) AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date
          AND e.start_at > (${nowParam}::timestamptz) - INTERVAL '7 days'
      `,
    });

  // Conditional claim: `WHERE ... IS NULL` makes this safe if two server
  // replicas ever run the cron concurrently, and — combined with running
  // this in the SAME transaction as the increment it gates — makes the whole
  // "claim, then act" sequence atomic (plan §4.8.2). Never increment-then-
  // stamp: a crash between the two double-penalises every non-responder.
  const claimMissedRsvpCountStmt = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (id) =>
      sql`UPDATE events SET missed_rsvp_counted_at = now() WHERE id = ${id} AND missed_rsvp_counted_at IS NULL RETURNING id`,
  });

  // The deferred "Dnes" started-post sweep (plan §15.2): all-day events that
  // are `started`, still on their FIRST local day (the `::date` match against
  // `start_at` — a multi-day event's day 2+ deliberately does not match, so
  // the post never lies about "today"), whose local time-of-day has reached
  // the team's configured `all_day_post_time`, and which have not posted yet.
  // `LEFT JOIN team_settings` + `COALESCE` on BOTH the timezone and the post
  // time — unlike the three reminder queries (which preserve an existing
  // INNER join), a team with no `team_settings` row must still get this post
  // (§4.4.4's argument, applied here because this is new behaviour, not
  // preserved behaviour). Open-ended `>=` on the time-of-day, not a
  // `BETWEEN`/5-minute window, so the post survives a short cron outage
  // instead of silently dropping it (mirrors `_findEventsForCoachingStatusAt`).
  const findAllDayEventsNeedingStartedPostStmt = (nowParam: string) =>
    SqlSchema.findAll({
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
        SELECT e.id, e.team_id, e.title, e.description, e.image_url, e.start_at, e.end_at,
               e.location, e.location_url, e.event_type,
               e.member_group_id, e.owner_group_id,
               ts.reminders_channel_id, e.all_day, e.claimed_by
        FROM events e
        LEFT JOIN team_settings ts ON ts.team_id = e.team_id
        WHERE e.all_day = TRUE
          AND e.status = 'started'
          AND e.all_day_post_sent_at IS NULL
          AND ((${nowParam}::timestamptz) AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date
              = (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date
          AND ((${nowParam}::timestamptz) AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::time
              >= COALESCE(ts.all_day_post_time, TIME '08:00')
      `,
    });

  const claimStartedPostStmt = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: Schema.Struct({ id: Event.EventId }),
    execute: (id) =>
      sql`UPDATE events SET all_day_post_sent_at = now() WHERE id = ${id} AND all_day_post_sent_at IS NULL RETURNING id`,
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

  // Parameterised exactly as `TeamSettingsRepository` does for its three
  // reminder queries (plan §7.7a), so the "+1 local day" arithmetic below is
  // testable without the wall clock. For a TIMED training, "ended" is still
  // the plain instant comparison; for an ALL-DAY training, `start_at` is now
  // a real team-local-midnight instant (not the old noon-UTC sentinel), so
  // the plain comparison would fire the auto-log the INSTANT the event
  // starts. Splice the shared `eventEndOfLastLocalDay` fragment (plan
  // §14.1/§14.4) for the all-day branch so it stays "not yet ended" through
  // the end of its last local day.
  const findEndedTrainingsAt = (nowParam: string) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        id: Event.EventId,
        start_at: Schemas.DateTimeFromDate,
        end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      }),
      execute: () => sql`
      SELECT e.id, e.start_at, e.end_at
      FROM events e
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.event_type = 'training'
        AND e.status IN ('active', 'started')
        AND e.auto_logged_at IS NULL
        AND (
          CASE WHEN e.all_day
            THEN ${sql.unsafe(eventEndOfLastLocalDay('e', "COALESCE(ts.timezone, 'Europe/Prague')"))} <= (${nowParam}::timestamptz)
            ELSE COALESCE(e.end_at, e.start_at) < (${nowParam}::timestamptz)
          END
        )
        AND COALESCE(e.end_at, e.start_at) > (${nowParam}::timestamptz) - INTERVAL '7 days'
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
      my_rsvp: Schema.OptionFromNullOr(EventRsvp.RsvpResponse),
      all_day: Schema.Boolean,
      // See `EventWithDetails.start_date` — same derived projection (plan §11.2/§11.3).
      start_date: Schema.String,
    }),
    execute: (input) => sql`
      SELECT e.id, e.title, e.event_type, e.start_at, e.end_at,
             e.location, e.location_url, e.member_group_id, e.all_day,
             er.response AS my_rsvp,
             (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                 AS start_date
      FROM events e
      LEFT JOIN event_rsvps er ON er.event_id = e.id AND er.team_member_id = ${input.team_member_id}
      LEFT JOIN team_settings ts ON ts.team_id = e.team_id
      WHERE e.team_id = ${input.team_id}
        AND ${sql.unsafe(eventVisibleNow('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
      ORDER BY ${sql.unsafe(eventDayOrder('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
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
                   COALESCE(SUM(CASE WHEN er.response IN ('maybe', 'coming_later') THEN 1 ELSE 0 END), 0)::int AS maybe_count
            FROM events e
            JOIN teams t ON t.id = e.team_id
            LEFT JOIN team_settings ts ON ts.team_id = t.id
            LEFT JOIN event_rsvps er ON er.event_id = e.id
            WHERE t.guild_id = ${input.guild_id}
              AND ${sql.unsafe(eventVisibleNow('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
            GROUP BY e.id, ts.timezone
            ORDER BY ${sql.unsafe(eventDayOrder('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
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
                   COALESCE(SUM(CASE WHEN er.response IN ('maybe', 'coming_later') THEN 1 ELSE 0 END), 0)::int AS maybe_count
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
      // Team's configured timezone (plan §11.1 row S1), used to project the calendar
      // date for the iCal feed's `VALUE=DATE` all-day events. This feed is cross-team
      // (JOIN teams), so the zone must be carried per row, not fetched once.
      team_timezone: Schema.String,
    }),
    execute: (userId) => sql`
            SELECT e.id, e.title, e.description, e.image_url, e.start_at, e.end_at,
                   e.location, e.location_url, e.status, e.event_type, t.name AS team_name,
                   er.response AS rsvp_response, e.all_day,
                   COALESCE(ts.timezone, 'Europe/Prague') AS team_timezone
            FROM events e
            JOIN teams t ON t.id = e.team_id
            JOIN team_members tm ON tm.team_id = t.id AND tm.active = true
            JOIN event_rsvps er ON er.event_id = e.id AND er.team_member_id = tm.id
            LEFT JOIN team_settings ts ON ts.team_id = t.id
            WHERE tm.user_id = ${userId}
              AND e.status IN ('active', 'started')
              AND er.response IN ('yes', 'maybe', 'coming_later')
            ORDER BY e.start_at ASC
          `,
  });

  // Paired with `findUpcomingByGuild` above (the page it counts) — the two
  // MUST change together, or the count desyncs from the page (BL2's exact
  // failure mode, plan §4.4/PR 4 task list).
  const countUpcomingByGuild = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (guildId) => sql`
            SELECT COUNT(*)::int AS count
            FROM events e
            JOIN teams t ON t.id = e.team_id
            LEFT JOIN team_settings ts ON ts.team_id = t.id
            WHERE t.guild_id = ${guildId}
              AND ${sql.unsafe(eventVisibleNow('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
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

  const findEndedTrainingsForAutoLogAt = (now: Date) =>
    findEndedTrainingsAt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const findEndedTrainingsForAutoLog = () => findEndedTrainingsForAutoLogAt(new Date());

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

  // Correlated scalar subselect for the team's timezone — NOT a join. Used by
  // the two UPDATE statements below, neither of which otherwise touches
  // `team_settings`; a scalar subselect is NULL-safe by construction (unlike
  // an inner `UPDATE ... FROM team_settings`) without requiring a join at all
  // (plan §4.4.4, mirrors `1791400000_anchor_all_day_to_team_midnight.ts`).
  const teamSettingsTimezoneSubselect =
    "COALESCE((SELECT ts.timezone FROM team_settings ts WHERE ts.team_id = e.team_id), 'Europe/Prague')";

  // Mark every upcoming/visible event for a team dirty so the personal-events
  // reconcile loop (re)builds personal messages — e.g. to populate a member's
  // freshly-provisioned channel with their existing events. Only touches events
  // that are not already dirty, so in-flight reconciles are left undisturbed.
  // Uses the shared `eventVisibleNow` predicate (plan PR 4 task 4.2) so a
  // member provisioned DURING an all-day event's own local day still gets a
  // message for it — the event is visible everywhere else already.
  const markTeamUpcomingPersonalMessagesDirty = SqlSchema.void({
    Request: Team.TeamId,
    execute: (teamId) =>
      sql`UPDATE events e SET personal_messages_dirty_at = date_trunc('milliseconds', now())
          WHERE e.team_id = ${teamId}
            AND ${sql.unsafe(eventVisibleNow('e', teamSettingsTimezoneSubselect))}
            AND e.personal_messages_dirty_at IS NULL`,
  });

  // Self-healing sweep: re-marks events that are no longer visible/upcoming
  // (the exact NEGATION of `eventVisibleNow` — plan §4.4.4) but still hold
  // personal_event_messages rows, so the bot's personal-events reconcile
  // deletes those stale personal messages. Only touches events that aren't
  // already dirty, and is self-terminating — once the reconcile deletes the
  // personal_event_messages rows for an event, it no longer matches the
  // `IN (SELECT DISTINCT event_id FROM personal_event_messages)` filter.
  //
  // MUST use the correlated scalar subselect above, NOT
  // `UPDATE events e ... FROM team_settings ts` — the latter is an INNER join
  // and would leave every event of a team with no `team_settings` row
  // permanently unswept, its stale personal messages never deleted, silently.
  // Getting this wrong the other way (still treating a `started` all-day
  // event on its own local day as stale) re-marks it dirty every cron cycle
  // and the reconcile deletes the message PR 4 decided to keep — an infinite
  // create/delete loop against the Discord API.
  const markStalePersonalMessagesDirtySchema = SqlSchema.void({
    Request: Schema.Void,
    execute: () => sql`
        UPDATE events e SET personal_messages_dirty_at = date_trunc('milliseconds', now())
        WHERE e.id IN (SELECT DISTINCT event_id FROM personal_event_messages)
          AND ${sql.unsafe(eventNotVisibleNow('e', teamSettingsTimezoneSubselect))}
          AND e.personal_messages_dirty_at IS NULL`,
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

  const markStalePersonalMessagesDirty = () =>
    markStalePersonalMessagesDirtySchema(undefined).pipe(catchSqlErrors);

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

  const findUnpostedUpcomingByChannelSchema = SqlSchema.findAll({
    Request: Discord.Snowflake,
    Result: Schema.Struct({ event_id: Event.EventId }),
    execute: (channelId) => sql`
      SELECT id AS event_id
      FROM events
      WHERE discord_channel_id = ${channelId}
        AND discord_message_id IS NULL
        AND status = 'active'
        AND start_at >= now()
      ORDER BY start_at ASC
    `,
  });

  const repointChannelEventsWithOld = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      old_channel_id: Discord.Snowflake,
      new_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    Result: Schema.Struct({
      event_id: Event.EventId,
      old_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    execute: (input) => sql`
      WITH moved AS (
        SELECT id, discord_message_id AS old_message_id
        FROM events
        WHERE team_id = ${input.team_id}
          AND status = 'active'
          AND start_at >= now()
          AND discord_channel_id = ${input.old_channel_id}
        FOR UPDATE
      ), upd AS (
        UPDATE events SET discord_channel_id = ${input.new_channel_id}, discord_message_id = NULL
        WHERE id IN (SELECT id FROM moved)
        RETURNING id
      )
      SELECT moved.id AS event_id, moved.old_message_id FROM moved JOIN upd ON upd.id = moved.id
    `,
  });

  const repointChannelEventsWithNullOld = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      new_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    Result: Schema.Struct({
      event_id: Event.EventId,
      old_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    execute: (input) => sql`
      WITH moved AS (
        SELECT id, discord_message_id AS old_message_id
        FROM events
        WHERE team_id = ${input.team_id}
          AND status = 'active'
          AND start_at >= now()
          AND discord_channel_id IS NULL
        FOR UPDATE
      ), upd AS (
        UPDATE events SET discord_channel_id = ${input.new_channel_id}, discord_message_id = NULL
        WHERE id IN (SELECT id FROM moved)
        RETURNING id
      )
      SELECT moved.id AS event_id, moved.old_message_id FROM moved JOIN upd ON upd.id = moved.id
    `,
  });

  const findUnpostedUpcomingByChannel = (channelId: Discord.Snowflake) =>
    findUnpostedUpcomingByChannelSchema(channelId).pipe(catchSqlErrors);

  const repointChannelEvents = (
    teamId: Team.TeamId,
    oldChannelId: Option.Option<Discord.Snowflake>,
    newChannelId: Option.Option<Discord.Snowflake>,
  ) =>
    Option.match(oldChannelId, {
      onNone: () =>
        repointChannelEventsWithNullOld({
          team_id: teamId,
          new_channel_id: newChannelId,
        }).pipe(catchSqlErrors),
      onSome: (old) =>
        repointChannelEventsWithOld({
          team_id: teamId,
          old_channel_id: old,
          new_channel_id: newChannelId,
        }).pipe(catchSqlErrors),
    });

  const findAllDayEventsPastLastLocalDay = (now: Date) =>
    findAllDayEventsPastLastLocalDayStmt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const claimMissedRsvpCount = (eventId: Event.EventId) =>
    claimMissedRsvpCountStmt(eventId).pipe(catchSqlErrors);

  const findAllDayEventsNeedingStartedPost = (now: Date) =>
    findAllDayEventsNeedingStartedPostStmt(now.toISOString())(undefined).pipe(catchSqlErrors);

  const claimStartedPost = (eventId: Event.EventId) =>
    claimStartedPostStmt(eventId).pipe(catchSqlErrors);

  // Exposes `sql.withTransaction` to consumers that don't otherwise hold a
  // `SqlClient` (e.g. `EventStartCron`'s deferred sweeps, plan §4.8.2/§15.2),
  // so "claim, then act" can run as one atomic unit even when the "act" half
  // (a missed-RSVP increment, or a started-post emit) is a call into a
  // DIFFERENT repository/service. Both sides resolve the same underlying
  // `SqlClient` service, so calls made inside `effect` participate in the
  // same transaction regardless of which repository's closure they came from.
  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect);

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
    findEndedTrainingsForAutoLogAt,
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
    markStalePersonalMessagesDirty,
    markSeriesFuturePersonalMessagesDirty,
    clearEventPersonalMessagesDirty,
    repointChannelEvents,
    findUnpostedUpcomingByChannel,
    findAllDayEventsPastLastLocalDay,
    claimMissedRsvpCount,
    findAllDayEventsNeedingStartedPost,
    claimStartedPost,
    withTransaction,
  };
});

export class EventsRepository extends ServiceMap.Service<
  EventsRepository,
  Effect.Success<typeof make>
>()('api/EventsRepository') {
  static readonly Default = Layer.effect(EventsRepository, make);
}
