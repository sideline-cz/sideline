import { Discord, Event, EventRosterModel, RosterModel, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class RequestRow extends Schema.Class<RequestRow>('EventRosterRequestRow')({
  id: EventRosterModel.EventRosterRequestId,
  event_id: Event.EventId,
  roster_id: RosterModel.RosterId,
  team_member_id: TeamMember.TeamMemberId,
  status: EventRosterModel.EventRosterRequestStatus,
  source: EventRosterModel.EventRosterRequestSource,
  was_member_before: Schema.Boolean,
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class MinRequestRow extends Schema.Class<MinRequestRow>('EventRosterMinRequestRow')({
  id: EventRosterModel.EventRosterRequestId,
  status: EventRosterModel.EventRosterRequestStatus,
  was_member_before: Schema.Boolean,
}) {}

class DecisionRow extends Schema.Class<DecisionRow>('EventRosterDecisionRow')({
  was_member_before: Schema.Boolean,
}) {}

class CancelRow extends Schema.Class<CancelRow>('EventRosterCancelRow')({
  status: EventRosterModel.EventRosterRequestStatus,
  was_member_before: Schema.Boolean,
}) {}

class PendingWithMemberRow extends Schema.Class<PendingWithMemberRow>('EventRosterPendingRow')({
  id: EventRosterModel.EventRosterRequestId,
  event_id: Event.EventId,
  roster_id: RosterModel.RosterId,
  team_member_id: TeamMember.TeamMemberId,
  discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  display_name: Schema.OptionFromNullOr(Schema.String),
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class PendingByRosterRow extends Schema.Class<PendingByRosterRow>('EventRosterPendingByRosterRow')({
  id: EventRosterModel.EventRosterRequestId,
  event_id: Event.EventId,
  roster_id: RosterModel.RosterId,
  team_member_id: TeamMember.TeamMemberId,
  event_title: Schema.String,
  discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  display_name: Schema.OptionFromNullOr(Schema.String),
  requested_at: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // -- raw SqlSchema helpers --------------------------------------------------

  const _findByEventAndMember = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: RequestRow,
    execute: (input) => sql`
      SELECT id, event_id, roster_id, team_member_id, status, source, was_member_before, discord_message_id
      FROM event_roster_requests
      WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
    `,
  });

  /**
   * Upsert as approved.
   * ON CONFLICT (event_id, team_member_id) → overwrite status/source but NOT was_member_before.
   * `was_member_before` is intentionally immutable-on-first-write: it records the roster state at
   * the moment the flow first touched the member, and must not be revised by subsequent transitions
   * (e.g. withdraw → re-RSVP yes). This ensures provenance protection (T10) is consistent.
   */
  const _upsertApproved = SqlSchema.findOne({
    Request: Schema.Struct({
      event_id: Event.EventId,
      roster_id: RosterModel.RosterId,
      team_member_id: TeamMember.TeamMemberId,
      was_member_before: Schema.Boolean,
    }),
    Result: MinRequestRow,
    execute: (input) => sql`
      INSERT INTO event_roster_requests (event_id, roster_id, team_member_id, status, source, was_member_before)
      VALUES (${input.event_id}, ${input.roster_id}, ${input.team_member_id}, 'approved', 'auto', ${input.was_member_before})
      ON CONFLICT (event_id, team_member_id)
      DO UPDATE SET status = 'approved', source = 'auto', updated_at = now()
      RETURNING id, status, was_member_before
    `,
  });

  /**
   * Upsert as pending — guarded: does NOT downgrade an already-approved row.
   * Uses conditional update to skip if status is already 'approved'.
   */
  const _upsertPendingInsert = SqlSchema.findOne({
    Request: Schema.Struct({
      event_id: Event.EventId,
      roster_id: RosterModel.RosterId,
      team_member_id: TeamMember.TeamMemberId,
      was_member_before: Schema.Boolean,
    }),
    Result: MinRequestRow,
    execute: (input) => sql`
      INSERT INTO event_roster_requests (event_id, roster_id, team_member_id, status, source, was_member_before)
      VALUES (${input.event_id}, ${input.roster_id}, ${input.team_member_id}, 'pending', 'approval', ${input.was_member_before})
      ON CONFLICT (event_id, team_member_id)
      DO UPDATE SET
        status = CASE WHEN event_roster_requests.status = 'approved' THEN 'approved' ELSE 'pending' END,
        source = CASE WHEN event_roster_requests.status = 'approved' THEN event_roster_requests.source ELSE 'approval' END,
        updated_at = now()
      RETURNING id, status, was_member_before
    `,
  });

  /**
   * Atomic guarded UPDATE — only transitions from pending to a decision.
   * Returns the row iff we won the race (status was pending).
   */
  const _claimDecision = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      to_status: EventRosterModel.EventRosterRequestStatus,
      decided_by: TeamMember.TeamMemberId,
    }),
    Result: DecisionRow,
    execute: (input) => sql`
      UPDATE event_roster_requests
      SET status = ${input.to_status}, decided_by = ${input.decided_by}, decided_at = now(), updated_at = now()
      WHERE event_id = ${input.event_id}
        AND team_member_id = ${input.team_member_id}
        AND status = 'pending'
      RETURNING was_member_before
    `,
  });

  // Use a CTE approach to capture the prior status before UPDATE:
  const _cancelWithPrior = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: CancelRow,
    execute: (input) => sql`
      WITH prior AS (
        SELECT status, was_member_before
        FROM event_roster_requests
        WHERE event_id = ${input.event_id}
          AND team_member_id = ${input.team_member_id}
          AND status IN ('pending', 'approved')
      ),
      updated AS (
        UPDATE event_roster_requests
        SET status = 'cancelled', updated_at = now()
        WHERE event_id = ${input.event_id}
          AND team_member_id = ${input.team_member_id}
          AND status IN ('pending', 'approved')
      )
      SELECT status, was_member_before FROM prior
    `,
  });

  const _saveMessageId = SqlSchema.void({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      message_id: Discord.Snowflake,
    }),
    execute: (input) => sql`
      UPDATE event_roster_requests
      SET discord_message_id = ${input.message_id}, updated_at = now()
      WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
    `,
  });

  const _findPendingByEvent = SqlSchema.findAll({
    Request: Event.EventId,
    Result: PendingWithMemberRow,
    execute: (eventId) => sql`
      SELECT r.id, r.event_id, r.roster_id, r.team_member_id,
             u.discord_id,
             COALESCE(u.discord_display_name, u.discord_nickname, u.name, u.username) AS display_name,
             r.discord_message_id
      FROM event_roster_requests r
      JOIN team_members tm ON tm.id = r.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE r.event_id = ${eventId} AND r.status = 'pending'
    `,
  });

  const _findPendingByRoster = SqlSchema.findAll({
    Request: RosterModel.RosterId,
    Result: PendingByRosterRow,
    execute: (rosterId) => sql`
      SELECT r.id, r.event_id, r.roster_id, r.team_member_id,
             e.title AS event_title,
             u.discord_id,
             COALESCE(u.discord_display_name, u.discord_nickname, u.name, u.username) AS display_name,
             r.created_at::text AS requested_at
      FROM event_roster_requests r
      JOIN events e ON e.id = r.event_id
      JOIN team_members tm ON tm.id = r.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE r.roster_id = ${rosterId} AND r.status = 'pending'
      ORDER BY r.created_at ASC
    `,
  });

  const _findById = SqlSchema.findOneOption({
    Request: EventRosterModel.EventRosterRequestId,
    Result: RequestRow,
    execute: (id) => sql`
      SELECT id, event_id, roster_id, team_member_id, status, source, was_member_before, discord_message_id
      FROM event_roster_requests
      WHERE id = ${id}
    `,
  });

  const _wasMemberBefore = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: Schema.Struct({ was_member_before: Schema.Boolean }),
    execute: (input) => sql`
      SELECT was_member_before
      FROM event_roster_requests
      WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
    `,
  });

  // -- public methods ---------------------------------------------------------

  const findById = (requestId: EventRosterModel.EventRosterRequestId) =>
    _findById(requestId).pipe(catchSqlErrors);

  const findByEventAndMember = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
    _findByEventAndMember({ event_id: eventId, team_member_id: memberId }).pipe(catchSqlErrors);

  const upsertApproved = (
    eventId: Event.EventId,
    rosterId: RosterModel.RosterId,
    memberId: TeamMember.TeamMemberId,
    wasMemberBefore: boolean,
  ) =>
    _upsertApproved({
      event_id: eventId,
      roster_id: rosterId,
      team_member_id: memberId,
      was_member_before: wasMemberBefore,
    }).pipe(catchSqlErrors);

  const upsertPending = (
    eventId: Event.EventId,
    rosterId: RosterModel.RosterId,
    memberId: TeamMember.TeamMemberId,
    wasMemberBefore: boolean,
  ) =>
    _upsertPendingInsert({
      event_id: eventId,
      roster_id: rosterId,
      team_member_id: memberId,
      was_member_before: wasMemberBefore,
    }).pipe(catchSqlErrors);

  const claimDecision = (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    toStatus: EventRosterModel.EventRosterRequestStatus,
    decidedBy: TeamMember.TeamMemberId,
  ) =>
    _claimDecision({
      event_id: eventId,
      team_member_id: memberId,
      to_status: toStatus,
      decided_by: decidedBy,
    }).pipe(catchSqlErrors);

  const cancel = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
    _cancelWithPrior({ event_id: eventId, team_member_id: memberId }).pipe(catchSqlErrors);

  const saveMessageId = (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    messageId: Discord.Snowflake,
  ) =>
    _saveMessageId({ event_id: eventId, team_member_id: memberId, message_id: messageId }).pipe(
      catchSqlErrors,
    );

  const findPendingByEvent = (eventId: Event.EventId) =>
    _findPendingByEvent(eventId).pipe(catchSqlErrors);

  const findPendingByRoster = (rosterId: RosterModel.RosterId) =>
    _findPendingByRoster(rosterId).pipe(catchSqlErrors);

  const wasMemberBefore = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
    _wasMemberBefore({ event_id: eventId, team_member_id: memberId }).pipe(
      catchSqlErrors,
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (r) => r.was_member_before,
        }),
      ),
    );

  return {
    findById,
    findByEventAndMember,
    upsertApproved,
    upsertPending,
    claimDecision,
    cancel,
    saveMessageId,
    findPendingByEvent,
    findPendingByRoster,
    wasMemberBefore,
  };
});

export class EventRosterRequestsRepository extends ServiceMap.Service<
  EventRosterRequestsRepository,
  Effect.Success<typeof make>
>()('api/EventRosterRequestsRepository') {
  static readonly Default = Layer.effect(EventRosterRequestsRepository, make);
}
