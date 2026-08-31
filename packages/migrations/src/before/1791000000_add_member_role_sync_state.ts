import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// PR-9 (Discord onboarding fix), 9b. `Role/MarkEventProcessed` and `Role/MarkEventFailed`
// (`applications/server/src/rpc/role/index.ts`) write these three columns whenever the event
// being marked carries a `team_member_id` (i.e. `role_assigned` / `role_unassigned` — the
// `role_created` / `role_deleted` events are team-scoped, not member-scoped, and never touch
// this row). They are what fills `roleSyncState` / `lastRoleSyncAt` / `lastRoleSyncError` on
// `RoleApi.SyncMemberRolesResult`, the DTO PR-7 already shipped (CC-8).
//
// `last_role_sync_state` is free TEXT, not a Postgres enum, mirroring `discord_code_error_code`
// on `invite_acceptances` — cheaper to widen later and the domain schema is the source of truth
// for the literal set. Columns, not a table (the plan's own call): one row's worth of "last sync"
// state per member is sufficient, there is no history requirement.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_role_sync_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_role_sync_state TEXT`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_role_sync_error TEXT`,
    ),
  ),
);
