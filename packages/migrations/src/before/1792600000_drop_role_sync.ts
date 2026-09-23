import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Release B of the Sideline-role -> Discord-role mirroring removal (expand/contract). Release A
// (#715) made the emit functions no-ops and drained nothing; this ticket removes the code surface
// entirely, so no deployed code references any of these objects anymore.
//
// A Sideline role is a permissions construct. Discord roles come from groups and rosters
// (channel_sync_events) and from achievements (role_provision_events) -- neither is touched here.
//
// teams.guild_id and idx_teams_guild_id came from the same original migration (1740970000) and
// are live across the whole Discord integration. They stay.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`DROP TABLE IF EXISTS role_sync_events`),
    Effect.tap(() => sql`DROP TABLE IF EXISTS discord_role_mappings`),
    // Provenance for "did Sideline itself grant this member this Discord role" (1791100000).
    // Its only writer was Role/MarkEventProcessed and its only readers were the three diff utils,
    // all removed in this change -- zero writers and zero readers remain.
    Effect.tap(() => sql`DROP TABLE IF EXISTS member_role_grants`),
    // Written only by RoleSyncEventsRepository.recordLastRoleSync, read only by
    // TeamMembersRepository.findLastRoleSync, surfaced only on the web "Sync roles" button that
    // #715 deleted (1791000000).
    Effect.tap(() => sql`ALTER TABLE team_members DROP COLUMN IF EXISTS last_role_sync_at`),
    Effect.tap(() => sql`ALTER TABLE team_members DROP COLUMN IF EXISTS last_role_sync_state`),
    Effect.tap(() => sql`ALTER TABLE team_members DROP COLUMN IF EXISTS last_role_sync_error`),
  ),
);
