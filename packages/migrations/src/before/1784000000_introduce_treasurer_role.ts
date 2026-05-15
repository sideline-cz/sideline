/**
 * Introduce the built-in `Treasurer` role and backfill missing built-in
 * permissions on legacy teams.
 *
 * KNOWN LIMITATION: If a team admin has previously created a custom (non-built-in)
 * role named "Treasurer", the `ON CONFLICT (team_id, name) DO NOTHING` clause in
 * statement 1 will silently skip the built-in insert for that team. The team will
 * be missing a built-in Treasurer role until an operator renames the custom role
 * and re-runs this migration (or manually inserts the row). Audit prod for
 * collisions with: SELECT team_id FROM roles WHERE name = 'Treasurer' AND is_built_in = false;
 *
 * The migration is additive only: it never DELETEs `role_permissions` rows.
 * If a Captain or Admin currently holds `finance:manage_fees` or
 * `finance:record_payments` (e.g. on teams seeded with older code defaults),
 * those grants are preserved.
 */
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        INSERT INTO roles (team_id, name, is_built_in)
        SELECT t.id, 'Treasurer', true
        FROM teams t
        ON CONFLICT (team_id, name) DO NOTHING
      `,
    ),
    Effect.tap(
      () => sql`
        INSERT INTO role_permissions (role_id, permission)
        SELECT r.id, perm
        FROM roles r
        CROSS JOIN (VALUES ('finance:view'), ('finance:manage_fees'), ('finance:record_payments')) AS p(perm)
        WHERE r.name = 'Treasurer' AND r.is_built_in = true
        ON CONFLICT DO NOTHING
      `,
    ),
    Effect.tap(
      () => sql`
        INSERT INTO role_permissions (role_id, permission)
        SELECT r.id, perm
        FROM roles r
        CROSS JOIN (VALUES ('activity-type:create'), ('activity-type:delete'), ('finance:view'), ('finance:manage_fees'), ('finance:record_payments')) AS p(perm)
        WHERE r.name = 'Admin' AND r.is_built_in = true
        ON CONFLICT DO NOTHING
      `,
    ),
    Effect.tap(
      () => sql`
        INSERT INTO role_permissions (role_id, permission)
        SELECT r.id, perm
        FROM roles r
        CROSS JOIN (VALUES ('activity-type:create'), ('finance:view')) AS p(perm)
        WHERE r.name = 'Captain' AND r.is_built_in = true
        ON CONFLICT DO NOTHING
      `,
    ),
  ),
);
