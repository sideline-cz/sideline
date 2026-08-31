import { Discord, Role, RoleApi, RoleSyncEvent, Team, TeamMember } from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: RoleSyncEvent.RoleSyncEventType,
  role_id: Role.RoleId,
  role_name: Schema.OptionFromNullOr(Schema.String),
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  discord_user_id: Schema.OptionFromNullOr(Discord.Snowflake),
});

class GuildLookupResult extends Schema.Class<GuildLookupResult>('GuildLookupResult')({
  guild_id: Discord.Snowflake,
}) {}

export class EventRow extends Schema.Class<EventRow>('EventRow')({
  id: RoleSyncEvent.RoleSyncEventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: RoleSyncEvent.RoleSyncEventType,
  role_id: Role.RoleId,
  role_name: Schema.OptionFromNullOr(Schema.String),
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  discord_user_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const MarkProcessedInput = Schema.Struct({
  id: RoleSyncEvent.RoleSyncEventId,
});

const MarkFailedInput = Schema.Struct({
  id: RoleSyncEvent.RoleSyncEventId,
  error: Schema.String,
});

// `RETURNING team_member_id` off the same UPDATE that marks the row processed/failed — cheap
// (one round-trip, not two) and gives `markProcessed`/`markFailed` what they need to decide
// whether there is a `team_members` row to update at all. `role_created` / `role_deleted` events
// carry no `team_member_id`, so this is `None` for them and the fidelity write is skipped.
class MarkResult extends Schema.Class<MarkResult>('MarkResult')({
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
}) {}

// Blocker (whole-series review, commit 46806427): `markProcessed` additionally RETURNs `role_id`
// and `event_type` so `rpc/role/index.ts`'s `Role/MarkEventProcessed` handler can update
// `member_role_grants` provenance — a `role_assigned` event that reaches here means the bot's
// `addGuildMemberRole` call actually succeeded; a `role_unassigned` event means its
// `deleteGuildMemberRole` call did. `role_id` / `event_type` are NOT NULL columns on
// `role_sync_events`, unlike `team_member_id`.
class MarkProcessedResult extends Schema.Class<MarkProcessedResult>('MarkProcessedResult')({
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  role_id: Role.RoleId,
  event_type: RoleSyncEvent.RoleSyncEventType,
}) {}

const RecordLastRoleSyncInput = Schema.Struct({
  team_member_id: TeamMember.TeamMemberId,
  state: Schema.Literals(['ok', 'failed']),
  error_code: Schema.OptionFromNullOr(RoleApi.DiscordSyncErrorCode),
  // Should-fix 1 (whole-series review): the poll-tick start `markProcessed` was called with. Only
  // meaningful when `state = 'ok'` — see `recordLastRoleSync`'s guard below. `markFailed` always
  // passes the current instant here; it is never read for `state = 'failed'` writes (short-circuit
  // on `input.state <> 'ok'`), so an unconditional "now" is fine, not a real staleness claim.
  tick_started_at: Schemas.DateTimeFromIsoString,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEvent = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO role_sync_events (team_id, guild_id, event_type, role_id, role_name, team_member_id, discord_user_id)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.event_type}, ${input.role_id}, ${input.role_name}, ${input.team_member_id}, ${input.discord_user_id})
    `,
  });

  const lookupGuildId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GuildLookupResult,
    execute: (teamId) => sql`SELECT guild_id FROM teams WHERE id = ${teamId}`,
  });

  const findUnprocessedEvents = SqlSchema.findAll({
    Request: Schema.Number,
    Result: EventRow,
    execute: (limit) => sql`
      SELECT id, team_id, guild_id, event_type, role_id, role_name, team_member_id, discord_user_id
      FROM role_sync_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  // `SqlSchema.findOne`, not `.void` (9b): the row being marked was just selected by
  // `findUnprocessed`, so the `UPDATE ... RETURNING` always yields exactly one row — see
  // `AGENTS.md`'s "INSERT ... RETURNING always yields one row" pattern. RETURNs `role_id` /
  // `event_type` too — see `MarkProcessedResult`'s doc comment.
  const markEventProcessed = SqlSchema.findOne({
    Request: MarkProcessedInput,
    Result: MarkProcessedResult,
    execute: (input) => sql`
      UPDATE role_sync_events SET processed_at = now() WHERE id = ${input.id}
      RETURNING team_member_id, role_id, event_type
    `,
  });

  const markEventFailed = SqlSchema.findOne({
    Request: MarkFailedInput,
    Result: MarkResult,
    execute: (input) => sql`
      UPDATE role_sync_events SET processed_at = now(), error = ${input.error} WHERE id = ${input.id}
      RETURNING team_member_id
    `,
  });

  // 9b: writes `team_members.last_role_sync_*`, which is what fills `roleSyncState` /
  // `lastRoleSyncAt` / `lastRoleSyncError` on `RoleApi.SyncMemberRolesResult` (PR-7's DTO).
  //
  // Should-fix 1 (whole-series review, commit 46806427): the trailing `AND (...)` guard stops a
  // `state = 'ok'` write from clobbering a `'failed'` recorded earlier IN THE SAME POLL TICK.
  // `role_sync_events` rows for one member's several roles are emitted in `discord_role_mappings`
  // row order (no `ORDER BY` on that SELECT — see `reconcileMemberDiscordRoles.ts` /
  // `syncMemberDiscordRoles.ts`), so which of a member's events a `concurrency: 1` drain processes
  // LAST within one tick is not meaningful; without the guard, a healthy role's `'ok'` landing
  // after a dangerous-permission role's `'captain_action'` failure erased the failure the UI has
  // dedicated copy for. The guard only blocks `'ok'` writes: `'failed'` always applies
  // unconditionally (`input.state <> 'ok'` short-circuits true), so any failure in a tick still
  // wins over any success in that same tick, and a GENUINELY new tick's success (`last_role_sync_at
  // < tick_started_at`, i.e. the recorded failure predates this tick) still clears a stale failure
  // once the underlying problem is fixed and re-synced.
  const recordLastRoleSync = SqlSchema.void({
    Request: RecordLastRoleSyncInput,
    execute: (input) => sql`
      UPDATE team_members
      SET last_role_sync_at = now(), last_role_sync_state = ${input.state}, last_role_sync_error = ${input.error_code}
      WHERE id = ${input.team_member_id}
        AND (
          ${input.state} <> 'ok'
          OR last_role_sync_state IS DISTINCT FROM 'failed'
          OR last_role_sync_at < ${input.tick_started_at}
        )
    `,
  });

  const _emitIfGuildLinked = (
    teamId: Team.TeamId,
    eventType: RoleSyncEvent.RoleSyncEventType,
    roleId: Role.RoleId,
    roleName: string,
    teamMemberId: Option.Option<TeamMember.TeamMemberId> = Option.none(),
    discordUserId: Option.Option<Discord.Snowflake> = Option.none(),
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
              role_id: roleId,
              role_name: Option.some(roleName),
              team_member_id: teamMemberId,
              discord_user_id: discordUserId,
            }),
        }),
      ),
      catchSqlErrors,
    );

  const emitRoleCreated = (teamId: Team.TeamId, roleId: Role.RoleId, roleName: string) =>
    _emitIfGuildLinked(teamId, 'role_created', roleId, roleName);

  const emitRoleDeleted = (teamId: Team.TeamId, roleId: Role.RoleId, roleName: string) =>
    _emitIfGuildLinked(teamId, 'role_deleted', roleId, roleName);

  const emitRoleAssigned = (
    teamId: Team.TeamId,
    roleId: Role.RoleId,
    roleName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(
      teamId,
      'role_assigned',
      roleId,
      roleName,
      Option.some(teamMemberId),
      Option.some(discordUserId),
    );

  const emitRoleUnassigned = (
    teamId: Team.TeamId,
    roleId: Role.RoleId,
    roleName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(
      teamId,
      'role_unassigned',
      roleId,
      roleName,
      Option.some(teamMemberId),
      Option.some(discordUserId),
    );

  const findUnprocessed = (limit: number) => findUnprocessedEvents(limit).pipe(catchSqlErrors);

  // `tickStartedAt` is the bot-side start of the poll tick this event was drained in — see
  // `recordLastRoleSync`'s guard doc comment. Returns `MarkProcessedResult` (not void) so
  // `rpc/role/index.ts`'s `Role/MarkEventProcessed` handler can update `member_role_grants`
  // provenance off the same `role_id` / `event_type` / `team_member_id` this UPDATE just resolved.
  const markProcessed = (id: RoleSyncEvent.RoleSyncEventId, tickStartedAt: DateTime.Utc) =>
    markEventProcessed({ id }).pipe(
      Effect.tap((result) =>
        Option.match(result.team_member_id, {
          onNone: () => Effect.void,
          onSome: (teamMemberId) =>
            recordLastRoleSync({
              team_member_id: teamMemberId,
              state: 'ok',
              error_code: Option.none(),
              tick_started_at: tickStartedAt,
            }),
        }),
      ),
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => `Role/MarkEventProcessed(${id}) — UPDATE returned no row`),
      ),
    );

  // `errorCode` is `Option.none()` for a classifier-transient failure (CC-0): a 429 or a
  // Discord 5xx must never be recorded as a user-visible sync failure, so `team_members` is left
  // untouched in that case — only `role_sync_events` itself is marked processed, which is safe
  // because the level-based diff (CC-10) re-derives the missing change on the next pass.
  const markFailed = (
    id: RoleSyncEvent.RoleSyncEventId,
    error: string,
    errorCode: Option.Option<RoleApi.DiscordSyncErrorCode>,
  ) =>
    markEventFailed({ id, error }).pipe(
      Effect.flatMap((result) =>
        Option.isSome(errorCode) && Option.isSome(result.team_member_id)
          ? recordLastRoleSync({
              team_member_id: result.team_member_id.value,
              state: 'failed',
              error_code: errorCode,
              // Never read by `recordLastRoleSync`'s guard for `state = 'failed'` writes (it
              // short-circuits on `input.state <> 'ok'`) — a real instant only because the column
              // is NOT NULL, not a staleness claim.
              tick_started_at: DateTime.nowUnsafe(),
            })
          : Effect.void,
      ),
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => `Role/MarkEventFailed(${id}) — UPDATE returned no row`),
      ),
    );

  return {
    emitRoleCreated,
    emitRoleDeleted,
    emitRoleAssigned,
    emitRoleUnassigned,
    findUnprocessed,
    markProcessed,
    markFailed,
  };
});

export class RoleSyncEventsRepository extends ServiceMap.Service<
  RoleSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/RoleSyncEventsRepository') {
  static readonly Default = Layer.effect(RoleSyncEventsRepository, make);
}
