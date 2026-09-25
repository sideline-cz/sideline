import { Event, EventRsvp, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { effectiveRolesFrom, holdsRsvpEligibleRoleWhere } from '~/repositories/effectiveRoles.js';

/**
 * Slice 3a of "Setup memberships" — the billing source of truth. A later slice reads ONLY rows
 * with `confirmed_at IS NOT NULL AND present`; this repository is the one writer of those two
 * columns, and every read here exists to support a human affirming (or a later slice billing
 * from) that state.
 *
 * PUT/`confirmAttendance` is a FULL REPLACE of the confirmed set for that event: every listed
 * candidate is sent in one payload, and every written row gets `confirmed_at = now()`. There is
 * no partial confirm. "This event is confirmed" therefore means "it has any confirmed row",
 * unambiguously — confirmation is all-or-nothing, so a captain can never leave the event
 * half-confirmed.
 */

class AttendanceRow extends Schema.Class<AttendanceRow>('AttendanceRow')({
  team_member_id: TeamMember.TeamMemberId,
  member_name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  rsvp_response: Schema.OptionFromNullOr(EventRsvp.RsvpResponse),
  present: Schema.Boolean,
  confirmed_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

const ConfirmInput = Schema.Struct({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  confirmed_by: TeamMember.TeamMemberId,
  // Pre-encoded `JSON.stringify([{ team_member_id, present, ord }, ...])`, bound as text and
  // cast `::jsonb` in the query — same convention as every other JSONB write in this repo
  // directory (see `DashboardLayoutsRepository`/`BankTransactionsRepository`).
  entries_json: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The candidate population. Same shape as `EventRsvpsRepository.findNonResponders`'s
  // missed-RSVP population (`tm.team_id`/`tm.active`, member-group descendants,
  // `holdsRsvpEligibleRoleWhere` — the CUMULATIVE was_default-or-built-in-Player cohort, NOT
  // `holdsDefaultRoleWhere`), with two deliberate differences:
  //
  // 1. NO `missed_rsvps < N` targeting filter — that filter exists purely to cap reminder spam
  //    and would silently drop members from an attendance list.
  // 2. The recursive group walk is the GUARDED form used elsewhere in this codebase
  //    (`GroupsRepository.countMembersForGroup`): `is_archived = false` in BOTH terms,
  //    `g.team_id = d.team_id` in the recursive term, and a `depth < 32` bound.
  //    `EventRsvpsRepository`'s own copy of this walk has NONE of those three guards — an
  //    archived subgroup's members are billable here but invisible to every other group-scoped
  //    surface, and an (unconstrained) cycle in `groups.parent_id` would spin forever. That is a
  //    known, separate issue in `EventRsvpsRepository`; do NOT "fix" it there as a side effect of
  //    this slice — changing it would change who gets RSVP reminders, which is out of scope here.
  //
  // Plus two OR escape hatches so nobody with real evidence (a submitted RSVP, or an existing
  // attendance row from a captain who already confirmed) is ever invisible, even if a role/group
  // change since would otherwise exclude them.
  const findByEventId = SqlSchema.findAll({
    Request: Event.EventId,
    Result: AttendanceRow,
    execute: (eventId) => sql`
      WITH RECURSIVE descendant_groups AS (
        SELECT g.id, g.team_id, 0 AS depth
        FROM groups g
        WHERE g.id = (SELECT e.member_group_id FROM events e WHERE e.id = ${eventId})
          AND g.is_archived = false
        UNION ALL
        SELECT g.id, g.team_id, d.depth + 1
        FROM groups g
        JOIN descendant_groups d ON g.parent_id = d.id
        WHERE g.is_archived = false AND g.team_id = d.team_id AND d.depth < 32
      ),
      candidates AS (
        SELECT tm.id AS team_member_id
        FROM team_members tm
        JOIN events e ON e.team_id = tm.team_id
        WHERE e.id = ${eventId}
          AND tm.active = true
          AND (
            e.member_group_id IS NULL
            OR tm.id IN (
              SELECT gm.team_member_id FROM group_members gm
              JOIN descendant_groups dg ON dg.id = gm.group_id
            )
          )
          AND EXISTS (
            SELECT 1 FROM ${sql.unsafe(effectiveRolesFrom('tm'))} eff
            WHERE eff.team_id = tm.team_id AND ${sql.unsafe(holdsRsvpEligibleRoleWhere('eff'))}
          )
        UNION
        SELECT er.team_member_id FROM event_rsvps er WHERE er.event_id = ${eventId}
        UNION
        SELECT ea.team_member_id FROM event_attendance ea WHERE ea.event_id = ${eventId}
      )
      SELECT
        c.team_member_id,
        u.name AS member_name,
        u.discord_nickname AS nickname,
        u.username,
        u.discord_display_name AS display_name,
        er.response AS rsvp_response,
        -- Stored value when a captain already confirmed; the live RSVP pre-tick otherwise. The
        -- trailing false is load-bearing: when NEITHER a stored row NOR an RSVP exists,
        -- er.response IN (...) is itself NULL (three-valued logic on a NULL column), and
        -- COALESCE only stops at the first NON-NULL argument -- so the un-responded case falls
        -- all the way through to this explicit floor instead of decoding as NULL.
        COALESCE(ea.present, er.response IN ('yes', 'coming_later'), false) AS present,
        ea.confirmed_at
      FROM candidates c
      JOIN team_members tm ON tm.id = c.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      LEFT JOIN event_rsvps er ON er.team_member_id = c.team_member_id AND er.event_id = ${eventId}
      LEFT JOIN event_attendance ea ON ea.team_member_id = c.team_member_id AND ea.event_id = ${eventId}
      ORDER BY COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) ASC
    `,
  });

  // ONE statement, event guards folded into the INSERT's own SELECT — a check-then-act would let
  // a cancellation land between the check and the write. Guards: the event exists, belongs to
  // this team, is a `'training'`, is not `'cancelled'`, and has started (`start_at <= now()`).
  // Zero rows returned means the guard refused; the caller 409s.
  //
  // ONE `jsonb_to_recordset` argument, not two parallel `unnest` arrays — verified on PG17:
  // unequal-length arrays silently pad with NULL and then 23502 on `present NOT NULL`.
  // `DISTINCT ON` is also verified-necessary: a duplicate member id in one payload would
  // otherwise 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time"; `ORDER BY
  // x.ord DESC` makes the LAST occurrence in the payload win, same as a plain object literal
  // with a repeated key.
  //
  // `JOIN team_members tm ON tm.team_id = e.team_id` accepts ANY member of the event's team —
  // deliberately NOT restricted to the candidate list above and NOT requiring `tm.active`, so a
  // captain can tick a walk-in, a member who left the group, or someone deactivated after the
  // training. A cross-team or unknown id is silently dropped rather than 500ing on an FK.
  //
  // `updated_at = now()` is explicit in the DO UPDATE — this table has no generic `updated_at`
  // trigger.
  const confirm = SqlSchema.findAll({
    Request: ConfirmInput,
    Result: Schema.Struct({ team_member_id: TeamMember.TeamMemberId }),
    execute: (input) => sql`
      INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at, confirmed_by)
      SELECT e.id, t.team_member_id, t.present, now(), ${input.confirmed_by}
      FROM events e
      JOIN LATERAL (
        SELECT DISTINCT ON (x.team_member_id) x.team_member_id, x.present
        FROM jsonb_to_recordset(${input.entries_json}::jsonb)
             AS x(team_member_id uuid, present boolean, ord int)
        ORDER BY x.team_member_id, x.ord DESC
      ) t ON true
      JOIN team_members tm ON tm.id = t.team_member_id AND tm.team_id = e.team_id
      WHERE e.id = ${input.event_id} AND e.team_id = ${input.team_id}
        AND e.event_type = 'training' AND e.status <> 'cancelled' AND e.start_at <= now()
      ON CONFLICT (event_id, team_member_id)
      DO UPDATE SET present = EXCLUDED.present, confirmed_at = now(),
                    confirmed_by = EXCLUDED.confirmed_by, updated_at = now()
      RETURNING team_member_id
    `,
  });

  const findConfirmedPresent = SqlSchema.findAll({
    Request: Event.EventId,
    Result: Schema.Struct({ team_member_id: TeamMember.TeamMemberId }),
    execute: (eventId) => sql`
      SELECT team_member_id
      FROM event_attendance
      WHERE event_id = ${eventId} AND confirmed_at IS NOT NULL AND present
    `,
  });

  const findAttendanceForEvent = (eventId: Event.EventId) =>
    findByEventId(eventId).pipe(catchSqlErrors);

  const confirmAttendance = (input: {
    event_id: Event.EventId;
    team_id: Team.TeamId;
    confirmed_by: TeamMember.TeamMemberId;
    entries: ReadonlyArray<{ team_member_id: TeamMember.TeamMemberId; present: boolean }>;
  }) =>
    confirm({
      event_id: input.event_id,
      team_id: input.team_id,
      confirmed_by: input.confirmed_by,
      entries_json: JSON.stringify(
        input.entries.map((entry, ord) => ({
          team_member_id: entry.team_member_id,
          present: entry.present,
          ord,
        })),
      ),
    }).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  const findConfirmedPresentMemberIds = (eventId: Event.EventId) =>
    findConfirmedPresent(eventId).pipe(catchSqlErrors);

  return {
    findAttendanceForEvent,
    confirmAttendance,
    findConfirmedPresentMemberIds,
  };
});

export class EventAttendanceRepository extends ServiceMap.Service<
  EventAttendanceRepository,
  Effect.Success<typeof make>
>()('api/EventAttendanceRepository') {
  static readonly Default = Layer.effect(EventAttendanceRepository, make);
}
