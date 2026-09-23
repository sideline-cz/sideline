import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`,
    ),
    // Behaviour-preserving backfill: every existing team keeps handing new members the built-in
    // Player. Cannot collide with the unique index below — `idx_roles_team_name` is a FULL unique
    // index on (team_id, name), so at most one 'Player' row can exist per team. Idempotent via
    // `AND is_default = false`.
    Effect.tap(
      () => sql`
        UPDATE roles
        SET is_default = true
        WHERE name = 'Player' AND is_built_in = true AND is_archived = false AND is_default = false
      `,
    ),
    // One default per team, enforced by the DB rather than app code. Partial, so archived rows never
    // occupy the slot. Created AFTER the backfill so it validates the backfilled state.
    // Not CONCURRENTLY: it cannot run inside the migration transaction, and the SHARE lock is
    // irrelevant at ~4-10 role rows per team.
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_team_default
        ON roles(team_id) WHERE is_default AND NOT is_archived
      `,
    ),
  ),
);
