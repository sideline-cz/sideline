import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Slice 2 of "Setup memberships" (players select which plan they want, with an optional
// deadline). Two independent columns, on two different tables — see each `Effect.tap` below.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // NULL means "on the team's default plan" — a COMPUTED fallback, resolved web-side from the
    // active plan list the caller already has, never backfilled. This is deliberate: a captain
    // switching which plan is default must move every member still on NULL along with it, and a
    // backfilled plan id would freeze each member onto whatever was default at migration time
    // instead. `ON DELETE SET NULL`, not `RESTRICT`, for two reasons — and NOT for the reason you
    // might assume. Deleting a team whose own member points at its own plan succeeds under BOTH
    // actions: non-deferrable FK triggers fire at END of the enclosing statement, by which point
    // the `team_members.team_id -> teams` cascade has already removed the referencing row, so the
    // RESTRICT check finds nothing and passes. (Measured, not reasoned — a regression to RESTRICT
    // is caught by the `delete_rule` assertion in the migration test, not by a delete-a-team test,
    // which stays green either way.) The actual reasons: (1) nothing prevents a `team_members` row
    // from naming ANOTHER team's plan, and under RESTRICT one such row makes that plan's team
    // permanently undeletable with an opaque 23503; (2) RESTRICT guards nothing real here, because
    // no code path hard-deletes a plan — `deleteMembershipPlan` archives. SET NULL also lands
    // exactly on the fallback the app already implements: no plan means the team default.
    Effect.tap(
      () => sql`
        ALTER TABLE team_members
          ADD COLUMN IF NOT EXISTS membership_plan_id UUID
            REFERENCES membership_plans(id) ON DELETE SET NULL
      `,
    ),
    // Deliberately on `teams`, NOT `team_settings`. A `teams` row always exists, so setting the
    // deadline is a plain UPDATE. `team_settings` is a one-to-one extension that must be created
    // (upserted) on first write, and creating that row is not side-effect-free: the RSVP-reminder,
    // claim-request, and coaching-status crons INNER JOIN `team_settings`, and
    // `rsvp_reminders_enabled` DEFAULTs to TRUE — so a team that had never opened its settings
    // would suddenly start getting Discord reminders the moment someone set a membership
    // selection deadline, purely as a side effect of the row now existing.
    Effect.tap(
      () => sql`
        ALTER TABLE teams
          ADD COLUMN IF NOT EXISTS membership_selection_deadline TIMESTAMPTZ
      `,
    ),
  ),
);
