import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE activity_types ADD COLUMN IF NOT EXISTS emoji TEXT`),
    Effect.tap(() => sql`ALTER TABLE activity_types ADD COLUMN IF NOT EXISTS description TEXT`),
    Effect.tap(
      () =>
        sql`ALTER TABLE activity_types ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ),
    Effect.tap(
      () =>
        sql`UPDATE activity_types SET emoji = '🏋️' WHERE slug = 'gym' AND team_id IS NULL AND emoji IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`UPDATE activity_types SET emoji = '🏃' WHERE slug = 'running' AND team_id IS NULL AND emoji IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`UPDATE activity_types SET emoji = '🧘' WHERE slug = 'stretching' AND team_id IS NULL AND emoji IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`UPDATE activity_types SET emoji = '⚽' WHERE slug = 'training' AND team_id IS NULL AND emoji IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_types_global_lower_name ON activity_types (LOWER(name)) WHERE team_id IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_types_team_lower_name ON activity_types (team_id, LOWER(name)) WHERE team_id IS NOT NULL`,
    ),
  ),
);
