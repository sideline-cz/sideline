import { Discord, Event, EventRpcModels, Team, TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array as Arr, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class JoinRequestRow extends Schema.Class<JoinRequestRow>('JoinRequestRow')({
  id: EventRpcModels.JoinRequestId,
  event_id: Event.EventId,
  team_member_id: TeamMember.TeamMemberId,
  status: EventRpcModels.JoinRequestStatus,
  member_display_name: Schema.OptionFromNullOr(Schema.String),
  member_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  message: Schema.OptionFromNullOr(Schema.String),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class JoinRequestIdRow extends Schema.Class<JoinRequestIdRow>('JoinRequestIdRow')({
  id: EventRpcModels.JoinRequestId,
  status: EventRpcModels.JoinRequestStatus,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _submit = SqlSchema.findAll({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      message: Schema.OptionFromNullOr(Schema.String),
    }),
    Result: JoinRequestIdRow,
    execute: (input) => sql`
      INSERT INTO event_join_requests (event_id, team_member_id, message)
      VALUES (${input.event_id}, ${input.team_member_id}, ${input.message})
      ON CONFLICT (event_id, team_member_id) DO UPDATE
        SET status = 'pending',
            decided_by = NULL,
            decided_at = NULL,
            message = EXCLUDED.message,
            updated_at = now()
        WHERE event_join_requests.status = 'declined'
      RETURNING id, status
    `,
  });

  const _findExistingRequest = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: JoinRequestIdRow,
    execute: (input) => sql`
      SELECT id, status FROM event_join_requests
      WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
    `,
  });

  const _accept = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EventRpcModels.JoinRequestId,
      decided_by: TeamMember.TeamMemberId,
      team_id: Team.TeamId,
    }),
    Result: Schema.Struct({ id: EventRpcModels.JoinRequestId }),
    execute: (input) => sql`
      UPDATE event_join_requests ejr
      SET status = 'accepted', decided_by = ${input.decided_by}, decided_at = now(), updated_at = now()
      FROM events e
      WHERE ejr.id = ${input.id}
        AND ejr.event_id = e.id
        AND ejr.status = 'pending'
        AND e.team_id = ${input.team_id}
      RETURNING ejr.id
    `,
  });

  const _decline = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EventRpcModels.JoinRequestId,
      decided_by: TeamMember.TeamMemberId,
      team_id: Team.TeamId,
    }),
    Result: Schema.Struct({ id: EventRpcModels.JoinRequestId }),
    execute: (input) => sql`
      UPDATE event_join_requests ejr
      SET status = 'declined', decided_by = ${input.decided_by}, decided_at = now(), updated_at = now()
      FROM events e
      WHERE ejr.id = ${input.id}
        AND ejr.event_id = e.id
        AND ejr.status = 'pending'
        AND e.team_id = ${input.team_id}
      RETURNING ejr.id
    `,
  });

  const _saveDiscordMessageId = SqlSchema.void({
    Request: Schema.Struct({
      id: EventRpcModels.JoinRequestId,
      channel_id: Discord.Snowflake,
      message_id: Discord.Snowflake,
    }),
    execute: (input) => sql`
      UPDATE event_join_requests
      SET discord_channel_id = ${input.channel_id}, discord_message_id = ${input.message_id}, updated_at = now()
      WHERE id = ${input.id}
    `,
  });

  const _findOverview = SqlSchema.findAll({
    Request: Schema.Struct({
      event_id: Event.EventId,
    }),
    Result: JoinRequestRow,
    execute: (input) => sql`
      SELECT
        ejr.id,
        ejr.event_id,
        ejr.team_member_id,
        ejr.status,
        COALESCE(u.discord_display_name, u.name) AS member_display_name,
        u.discord_id AS member_discord_id,
        ejr.message,
        ejr.discord_channel_id,
        ejr.discord_message_id
      FROM event_join_requests ejr
      LEFT JOIN team_members tm ON tm.id = ejr.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE ejr.event_id = ${input.event_id}
        AND ejr.status IN ('accepted', 'pending')
      ORDER BY ejr.created_at ASC
    `,
  });

  const _findById = SqlSchema.findOneOption({
    Request: EventRpcModels.JoinRequestId,
    Result: JoinRequestRow,
    execute: (id) => sql`
      SELECT
        ejr.id,
        ejr.event_id,
        ejr.team_member_id,
        ejr.status,
        COALESCE(u.discord_display_name, u.name) AS member_display_name,
        u.discord_id AS member_discord_id,
        ejr.message,
        ejr.discord_channel_id,
        ejr.discord_message_id
      FROM event_join_requests ejr
      LEFT JOIN team_members tm ON tm.id = ejr.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE ejr.id = ${id}
    `,
  });

  const _checkRosterManagePermission = SqlSchema.findOneOption({
    Request: Schema.Struct({
      team_member_id: TeamMember.TeamMemberId,
      team_id: Team.TeamId,
    }),
    Result: Schema.Struct({ has_permission: Schema.Boolean }),
    execute: (input) => sql`
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT rp.permission
          FROM member_roles mr
          JOIN role_permissions rp ON rp.role_id = mr.role_id
          WHERE mr.team_member_id = ${input.team_member_id}
          UNION
          SELECT rp.permission
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
          JOIN role_permissions rp ON rp.role_id = rg.role_id
          WHERE gm.team_member_id = ${input.team_member_id}
        ) perms
        WHERE perms.permission = 'roster:manage'
      ) AS has_permission
    `,
  });

  const toEntry = (r: JoinRequestRow) =>
    new EventRpcModels.JoinRequestEntry({
      id: r.id,
      event_id: r.event_id,
      team_member_id: r.team_member_id,
      status: r.status,
      member_display_name: r.member_display_name,
      member_discord_id: r.member_discord_id,
      message: r.message,
      discord_channel_id: r.discord_channel_id,
      discord_message_id: r.discord_message_id,
    });

  /**
   * Submits a join request.
   * - If no existing row: inserts a new pending row → returns { entry, created: true }.
   * - If existing row is 'declined': reopens to pending via DO UPDATE → returns { entry, created: true }.
   * - If existing row is 'pending' or 'accepted': DO UPDATE WHERE clause is false → no row returned
   *   → falls through to fetch existing row → returns { entry, created: false }.
   *
   * The `created` flag tells the caller whether to post a new review message.
   */
  const submit = (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    _memberDisplayName: Option.Option<string>,
    _memberDiscordId: Option.Option<Discord.Snowflake>,
    message: Option.Option<string>,
  ) =>
    _submit({ event_id: eventId, team_member_id: memberId, message }).pipe(
      Effect.flatMap((rows) => {
        if (rows.length > 0) {
          // Row was returned: fresh insert OR declined row reopened to pending — created = true
          const row = rows[0];
          return _findById(row.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => LogicError.die(`Join request ${row.id} not found after insert`),
                onSome: (r) =>
                  Effect.succeed({
                    entry: toEntry(r),
                    created: true,
                  }),
              }),
            ),
          );
        }
        // No row returned: ON CONFLICT DO UPDATE WHERE status='declined' did not fire
        // because the existing row is 'pending' or 'accepted' — created = false
        return _findExistingRequest({ event_id: eventId, team_member_id: memberId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                LogicError.die(
                  `Existing join request not found for event ${eventId} member ${memberId}`,
                ),
              onSome: (existing) =>
                _findById(existing.id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        LogicError.die(`Join request ${existing.id} not found after conflict`),
                      onSome: (r) =>
                        Effect.succeed({
                          entry: toEntry(r),
                          created: false,
                        }),
                    }),
                  ),
                ),
            }),
          ),
        );
      }),
      catchSqlErrors,
    );

  const accept = (
    requestId: EventRpcModels.JoinRequestId,
    deciderMemberId: TeamMember.TeamMemberId,
    teamId: Team.TeamId,
  ) =>
    _accept({ id: requestId, decided_by: deciderMemberId, team_id: teamId }).pipe(
      Effect.flatMap((result) => {
        if (Option.isNone(result)) {
          return Effect.succeed(Option.none<EventRpcModels.JoinRequestEntry>());
        }
        return _findById(requestId).pipe(Effect.map(Option.map(toEntry)));
      }),
      catchSqlErrors,
    );

  const decline = (
    requestId: EventRpcModels.JoinRequestId,
    deciderMemberId: TeamMember.TeamMemberId,
    teamId: Team.TeamId,
  ) =>
    _decline({ id: requestId, decided_by: deciderMemberId, team_id: teamId }).pipe(
      Effect.flatMap((result) => {
        if (Option.isNone(result)) {
          return Effect.succeed(Option.none<EventRpcModels.JoinRequestEntry>());
        }
        return _findById(requestId).pipe(Effect.map(Option.map(toEntry)));
      }),
      catchSqlErrors,
    );

  const saveDiscordMessageId = (
    requestId: EventRpcModels.JoinRequestId,
    channelId: Discord.Snowflake,
    messageId: Discord.Snowflake,
  ) =>
    _saveDiscordMessageId({ id: requestId, channel_id: channelId, message_id: messageId }).pipe(
      catchSqlErrors,
    );

  const findOverview = (eventId: Event.EventId) =>
    _findOverview({ event_id: eventId }).pipe(
      Effect.map((rows) => {
        const accepted = Arr.filter(rows, (r) => r.status === 'accepted').map(toEntry);
        const pending = Arr.filter(rows, (r) => r.status === 'pending').map(toEntry);
        return new EventRpcModels.AttendanceOverview({ event_id: eventId, accepted, pending });
      }),
      catchSqlErrors,
    );

  const findRequestById = (requestId: EventRpcModels.JoinRequestId) =>
    _findById(requestId).pipe(Effect.map(Option.map(toEntry)), catchSqlErrors);

  const hasRosterManagePermission = (memberId: TeamMember.TeamMemberId, teamId: Team.TeamId) =>
    _checkRosterManagePermission({ team_member_id: memberId, team_id: teamId }).pipe(
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (r) => r.has_permission,
        }),
      ),
      catchSqlErrors,
    );

  return {
    submit,
    accept,
    decline,
    saveDiscordMessageId,
    findOverview,
    findRequestById,
    hasRosterManagePermission,
  };
});

export class EventJoinRequestsRepository extends ServiceMap.Service<
  EventJoinRequestsRepository,
  Effect.Success<typeof make>
>()('api/EventJoinRequestsRepository') {
  static readonly Default = Layer.effect(EventJoinRequestsRepository, make);
}
