import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Sticky companion to `is_default`: set when a role BECOMES the team's default, never cleared
    // when a later role takes over. `is_default` answers "who do new members get" (one row per
    // team, enforced by `idx_roles_team_default`); `was_default` answers "who was ever handed out
    // as the default", which is the population RSVP reminders and `missed_rsvps` must keep
    // covering. Collapsing the latter into the former is what stranded the previous cohort on a
    // team's second default change.
    Effect.tap(
      () =>
        sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS was_default BOOLEAN NOT NULL DEFAULT false`,
    ),
    // Backfill = exactly today's RSVP union (`is_default OR built-in Player`), so the migration is
    // behaviour-preserving: no member gains or loses reminders at deploy time. Past defaults that
    // were already superseded are NOT recoverable here — nothing recorded them — so a team that had
    // already switched twice keeps its stranded cohort until someone re-sets that role as default.
    // Idempotent via `was_default = false`. Archived rows included: `effectiveRolesFrom` filters
    // them out anyway, and an un-archived ex-default should stay eligible.
    Effect.tap(
      () => sql`
        UPDATE roles
        SET was_default = true
        WHERE was_default = false
          AND (is_default = true OR (name = 'Player' AND is_built_in = true))
      `,
    ),
  ),
);
