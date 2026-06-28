import { Discord, Event, EventRsvp, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class RsvpWithMemberName extends Schema.Class<RsvpWithMemberName>('RsvpWithMemberName')({
  id: EventRsvp.EventRsvpId,
  event_id: Event.EventId,
  team_member_id: TeamMember.TeamMemberId,
  response: EventRsvp.RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
  member_name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
}) {}

class RsvpRow extends Schema.Class<RsvpRow>('RsvpRow')({
  id: EventRsvp.EventRsvpId,
  event_id: Event.EventId,
  team_member_id: TeamMember.TeamMemberId,
  response: EventRsvp.RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
}) {}

const UpsertInput = Schema.Struct({
  event_id: Schema.String,
  team_member_id: Schema.String,
  response: Schema.String,
  message: Schema.OptionFromNullOr(Schema.String),
});

const UpsertClearInput = Schema.Struct({
  event_id: Schema.String,
  team_member_id: Schema.String,
  response: Schema.String,
});

class RsvpWithDiscordInfo extends Schema.Class<RsvpWithDiscordInfo>('RsvpWithDiscordInfo')({
  discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  member_name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  response: EventRsvp.RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
}) {}

class NonResponderRow extends Schema.Class<NonResponderRow>('NonResponderRow')({
  team_member_id: TeamMember.TeamMemberId,
  member_name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class TotalCount extends Schema.Class<TotalCount>('TotalCount')({
  count: Schema.NumberFromString,
}) {}

class ResponseCount extends Schema.Class<ResponseCount>('ResponseCount')({
  response: EventRsvp.RsvpResponse,
  count: Schema.NumberFromString,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByEventId = SqlSchema.findAll({
    Request: Event.EventId,
    Result: RsvpWithMemberName,
    execute: (eventId) => sql`
      SELECT r.id, r.event_id, r.team_member_id, r.response, r.message,
             u.name AS member_name, u.username,
             u.discord_nickname AS nickname, u.discord_display_name AS display_name
      FROM event_rsvps r
      JOIN team_members tm ON tm.id = r.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE r.event_id = ${eventId}
      ORDER BY r.created_at ASC
    `,
  });

  const findByEventAndMember = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Schema.String,
      team_member_id: Schema.String,
    }),
    Result: RsvpRow,
    execute: (input) => sql`
      SELECT id, event_id, team_member_id, response, message
      FROM event_rsvps
      WHERE event_id = ${input.event_id}
        AND team_member_id = ${input.team_member_id}
    `,
  });

  class UpsertWithPriorResult extends Schema.Class<UpsertWithPriorResult>('UpsertWithPriorResult')({
    id: EventRsvp.EventRsvpId,
    event_id: Event.EventId,
    team_member_id: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Schema.OptionFromNullOr(Schema.String),
    prior_response: Schema.OptionFromNullOr(EventRsvp.RsvpResponse),
  }) {}

  const upsert = SqlSchema.findOne({
    Request: UpsertInput,
    Result: UpsertWithPriorResult,
    execute: (input) => sql`
      WITH prior AS (
        SELECT response AS prior_response
        FROM event_rsvps
        WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
      )
      INSERT INTO event_rsvps (event_id, team_member_id, response, message)
      VALUES (${input.event_id}, ${input.team_member_id}, ${input.response}, ${input.message})
      ON CONFLICT (event_id, team_member_id)
      DO UPDATE SET response = ${input.response}, message = COALESCE(${input.message}, event_rsvps.message), updated_at = now()
      RETURNING id, event_id, team_member_id, response, message,
                (SELECT prior_response FROM prior) AS prior_response
    `,
  });

  const upsertClearing = SqlSchema.findOne({
    Request: UpsertClearInput,
    Result: UpsertWithPriorResult,
    execute: (input) => sql`
      WITH prior AS (
        SELECT response AS prior_response
        FROM event_rsvps
        WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
      )
      INSERT INTO event_rsvps (event_id, team_member_id, response, message)
      VALUES (${input.event_id}, ${input.team_member_id}, ${input.response}, NULL)
      ON CONFLICT (event_id, team_member_id)
      DO UPDATE SET response = ${input.response}, message = NULL, updated_at = now()
      RETURNING id, event_id, team_member_id, response, message,
                (SELECT prior_response FROM prior) AS prior_response
    `,
  });

  const countByEventId = SqlSchema.findAll({
    Request: Event.EventId,
    Result: ResponseCount,
    execute: (eventId) => sql`
      SELECT response, COUNT(*)::text AS count
      FROM event_rsvps
      WHERE event_id = ${eventId}
      GROUP BY response
    `,
  });

  const findAttendeesPage = SqlSchema.findAll({
    Request: Schema.Struct({
      event_id: Schema.String,
      limit: Schema.Number,
      offset: Schema.Number,
    }),
    Result: RsvpWithDiscordInfo,
    execute: (input) => sql`
      SELECT u.discord_id, u.name AS member_name, u.discord_nickname AS nickname, u.username, u.discord_display_name AS display_name, r.response, r.message
      FROM event_rsvps r
      JOIN team_members tm ON tm.id = r.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE r.event_id = ${input.event_id}
      ORDER BY CASE r.response WHEN 'yes' THEN 1 WHEN 'maybe' THEN 2 WHEN 'no' THEN 3 ELSE 99 END ASC, r.created_at ASC, r.id ASC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `,
  });

  const countTotalByEventId = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: TotalCount,
    execute: (eventId) => sql`
      SELECT COUNT(*)::text AS count
      FROM event_rsvps
      WHERE event_id = ${eventId}
    `,
  });

  const findYesAttendeesWithLimit = SqlSchema.findAll({
    Request: Schema.Struct({
      event_id: Schema.String,
      limit: Schema.Number,
      member_group_id: Schema.OptionFromNullOr(Schema.String),
    }),
    Result: RsvpWithDiscordInfo,
    execute: (input) => sql`
      SELECT u.discord_id, u.name AS member_name, u.discord_nickname AS nickname, u.username, u.discord_display_name AS display_name, r.response, r.message
      FROM event_rsvps r
      JOIN team_members tm ON tm.id = r.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE r.event_id = ${input.event_id}
        AND r.response = 'yes'
        AND (
          ${input.member_group_id}::uuid IS NULL
          OR tm.id IN (
            WITH RECURSIVE descendant_groups AS (
              SELECT id FROM groups WHERE id = ${input.member_group_id}::uuid
              UNION ALL
              SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id
            )
            SELECT gm.team_member_id
            FROM group_members gm
            JOIN descendant_groups dg ON dg.id = gm.group_id
          )
        )
      ORDER BY r.created_at ASC
      LIMIT ${input.limit}
    `,
  });

  const findYesRsvpMemberIds = SqlSchema.findAll({
    Request: Event.EventId,
    Result: Schema.Struct({ team_member_id: TeamMember.TeamMemberId }),
    execute: (eventId) => sql`
      SELECT team_member_id
      FROM event_rsvps
      WHERE event_id = ${eventId}
        AND response = 'yes'
    `,
  });

  const findNonResponders = SqlSchema.findAll({
    Request: Schema.Struct({
      event_id: Schema.String,
      team_id: Schema.String,
      member_group_id: Schema.OptionFromNullOr(Schema.String),
      max_missed_rsvps: Schema.Number,
    }),
    Result: NonResponderRow,
    execute: (input) => sql`
      WITH eligible_members AS (
        SELECT tm.id AS team_member_id, tm.user_id
        FROM team_members tm
        WHERE tm.team_id = ${input.team_id}
          AND tm.active = true
          AND tm.missed_rsvps < ${input.max_missed_rsvps}
          AND (
            ${input.member_group_id}::uuid IS NULL
            OR tm.id IN (
              WITH RECURSIVE descendant_groups AS (
                SELECT id FROM groups WHERE id = ${input.member_group_id}::uuid
                UNION ALL
                SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id
              )
              SELECT gm.team_member_id
              FROM group_members gm
              JOIN descendant_groups dg ON dg.id = gm.group_id
            )
          )
          AND EXISTS (
            SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
            WHERE mr.team_member_id = tm.id AND r.team_id = ${input.team_id}
              AND r.name = 'Player' AND r.is_built_in = true
          )
      )
      SELECT em.team_member_id, u.name AS member_name, u.discord_nickname AS nickname, u.username, u.discord_display_name AS display_name, u.discord_id
      FROM eligible_members em
      LEFT JOIN users u ON u.id = em.user_id
      LEFT JOIN event_rsvps er ON er.team_member_id = em.team_member_id AND er.event_id = ${input.event_id}
      WHERE er.id IS NULL
      ORDER BY u.name ASC
    `,
  });

  const incrementMissedForEventNonResponders = SqlSchema.void({
    Request: Schema.Struct({
      event_id: Schema.String,
      team_id: Schema.String,
      member_group_id: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) => sql`
      WITH RECURSIVE descendant_groups AS (
        SELECT id FROM groups WHERE id = ${input.member_group_id}::uuid
        UNION ALL
        SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id
      )
      UPDATE team_members tm
      SET missed_rsvps = missed_rsvps + 1
      WHERE tm.team_id = ${input.team_id}
        AND tm.active = true
        AND (
          ${input.member_group_id}::uuid IS NULL
          OR tm.id IN (SELECT gm.team_member_id FROM group_members gm
                       JOIN descendant_groups dg ON dg.id = gm.group_id)
        )
        AND EXISTS (
          SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
          WHERE mr.team_member_id = tm.id AND r.team_id = ${input.team_id}
            AND r.name = 'Player' AND r.is_built_in = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_rsvps er
          WHERE er.team_member_id = tm.id AND er.event_id = ${input.event_id}
        )
    `,
  });

  const findRsvpsByEventId = (eventId: Event.EventId) =>
    findByEventId(eventId).pipe(catchSqlErrors);

  const findRsvpByEventAndMember = (
    eventId: Event.EventId,
    teamMemberId: TeamMember.TeamMemberId,
  ) =>
    findByEventAndMember({ event_id: eventId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  const upsertRsvp = (
    eventId: Event.EventId,
    teamMemberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
    clearMessage = false,
  ) =>
    (clearMessage
      ? upsertClearing({ event_id: eventId, team_member_id: teamMemberId, response })
      : upsert({ event_id: eventId, team_member_id: teamMemberId, response, message })
    ).pipe(
      catchSqlErrors,
      Effect.map((row) => ({
        row: {
          id: row.id,
          event_id: row.event_id,
          team_member_id: row.team_member_id,
          response: row.response,
          message: row.message,
        },
        priorResponse: row.prior_response,
      })),
    );

  const countRsvpsByEventId = (eventId: Event.EventId) =>
    countByEventId(eventId).pipe(catchSqlErrors);

  const findRsvpAttendeesPage = (eventId: Event.EventId, offset: number, limit: number) =>
    findAttendeesPage({ event_id: eventId, limit, offset }).pipe(catchSqlErrors);

  const findNonRespondersByEventId = (
    eventId: Event.EventId,
    teamId: string,
    memberGroupId: Option.Option<string> = Option.none(),
    maxMissedRsvps = 4,
  ) =>
    findNonResponders({
      event_id: eventId,
      team_id: teamId,
      member_group_id: memberGroupId,
      max_missed_rsvps: maxMissedRsvps,
    }).pipe(catchSqlErrors);

  const incrementMissedForEventNonRespondersByEventId = (
    eventId: Event.EventId,
    teamId: string,
    memberGroupId: Option.Option<string>,
  ) =>
    incrementMissedForEventNonResponders({
      event_id: eventId,
      team_id: teamId,
      member_group_id: memberGroupId,
    }).pipe(catchSqlErrors);

  const countRsvpTotal = (eventId: Event.EventId) =>
    countTotalByEventId(eventId).pipe(
      Effect.map(Option.match({ onNone: () => 0, onSome: (r) => r.count })),
      catchSqlErrors,
    );

  const findYesAttendeesForEmbed = (
    eventId: Event.EventId,
    limit: number,
    memberGroupId: Option.Option<string> = Option.none(),
  ) =>
    findYesAttendeesWithLimit({
      event_id: eventId,
      limit,
      member_group_id: memberGroupId,
    }).pipe(catchSqlErrors);

  const findYesRsvpMemberIdsByEventId = (eventId: Event.EventId) =>
    findYesRsvpMemberIds(eventId).pipe(catchSqlErrors);

  return {
    findRsvpsByEventId,
    findRsvpByEventAndMember,
    upsertRsvp,
    countRsvpsByEventId,
    findRsvpAttendeesPage,
    findNonRespondersByEventId,
    countRsvpTotal,
    findYesAttendeesForEmbed,
    findYesRsvpMemberIdsByEventId,
    incrementMissedForEventNonRespondersByEventId,
  };
});

export class EventRsvpsRepository extends ServiceMap.Service<
  EventRsvpsRepository,
  Effect.Success<typeof make>
>()('api/EventRsvpsRepository') {
  static readonly Default = Layer.effect(EventRsvpsRepository, make);
}
