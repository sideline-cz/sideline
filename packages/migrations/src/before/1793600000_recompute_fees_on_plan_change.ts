import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Training-period charges are recomputed lazily, by trigger. Two writers were covered
 * (`event_attendance` and `events`, 1793200000) and a third was added for a plan's pricing
 * (`membership_plans_pricing_recompute_trg`, 1793400000). The writer that moves the MOST money
 * per statement was never covered at all: `team_members.membership_plan_id`.
 *
 * `training_period_charges` reads that column live, so the amounts are correct the instant
 * anything recomputes -- the bug is purely that nothing does. A treasurer moves twelve members
 * onto a paid plan, sees this month's outstanding amounts unchanged, and concludes the feature
 * is broken. It is not: the numbers correct themselves the next time anyone marks attendance in
 * that period.
 *
 * Fixed at the trigger layer, not in the three repository methods that write the column
 * (`selectMembershipPlan`, `assignMembershipPlan`, `reassignMembershipPlan`). One trigger covers
 * all three plus every future writer, and keeps the money-moving side effect off endpoints that
 * were deliberately kept free of one.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- 1 the recompute on a member's plan change -----------------------------------------
    // STATEMENT-level with transition tables, NOT a per-row trigger like every sibling in this
    // family. `reassignMembershipPlan` is a single UPDATE that moves a whole squad, and a per-row
    // trigger would run one full recompute_training_period_fees per moved member inside one
    // transaction -- each of them three training_period_charges calls (S0/S2/S3), all of it while
    // holding the team-wide fees mutex S1 takes. On a 30-member move with an allowance set that
    // is the same cost class 1793500000 measured and then designed away for bulk confirms. One
    // statement, one recompute.
    //
    // The price of that choice: Postgres materialises BOTH transition tuplestores for EVERY
    // `team_members` UPDATE, including the hot Discord-sync ones that never touch this column,
    // because a statement-level trigger admits no WHEN clause to filter on first. That is the
    // trade -- a small per-statement tuplestore against an N-fold money recompute -- and the
    // IS DISTINCT FROM join below is what keeps the FUNCTION a no-op for those statements.
    //
    // Only UPDATE. An INSERT cannot owe anything (a brand-new member has no attendance yet), and
    // a DELETE cascades into `event_attendance`, whose own trigger already recomputes.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION team_members_plan_recompute() RETURNS trigger AS $$
        DECLARE
          v_team_id UUID;
        BEGIN
          -- ORDER BY is the LOCK ORDER, not cosmetics. Nothing in the app updates team_members
          -- across teams in one statement today, but the loop takes a team-wide fees mutex per
          -- iteration, and two such statements meeting in the opposite order is a 40P01 that
          -- surfaces as an untyped SqlError on a money write (AGENTS.md invariant 2).
          --
          -- n.team_id, not o.team_id: they are the same value on every path (team_members.team_id
          -- is never updated anywhere in this codebase; a member moving clubs is a new row).
          --
          -- The IS DISTINCT FROM is the whole filter, standing in for the WHEN clause a
          -- statement-level trigger cannot have. Every team_members UPDATE that leaves the plan
          -- alone -- the Discord sync's, an active toggle, a variable_symbol edit -- yields
          -- zero rows here and takes no lock at all.
          FOR v_team_id IN
            SELECT DISTINCT n.team_id
            FROM new_rows n
            JOIN old_rows o ON o.id = n.id
            WHERE n.membership_plan_id IS DISTINCT FROM o.membership_plan_id
            ORDER BY 1
          LOOP
            -- CURRENT period only, matching membership_plans_pricing_recompute. A past period is
            -- frozen by recompute_training_period_fees' own early return (1793200000), so a late
            -- reassignment cannot reopen a settled month -- and that guard, not this call site,
            -- is what makes firing here unconditionally safe.
            PERFORM recompute_training_period_fees(
              v_team_id, training_period_start(now(), v_team_id)
            );
          END LOOP;

          -- AFTER STATEMENT triggers ignore the return value; NULL is the convention.
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER team_members_plan_recompute_trg
          AFTER UPDATE ON team_members
          REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
          FOR EACH STATEMENT
          EXECUTE FUNCTION team_members_plan_recompute()
      `,
    ),

    // ---- 2 the pricing trigger watched only two of the five money columns -------------------
    // Re-issued in full -- 1793400000's version watches price_per_training_minor and
    // free_trainings_included and nothing else, which misses three changes that move exactly the
    // same money:
    //   * currency      -- the charge is emitted in the plan's currency, and fees shells are
    //                      keyed per currency.
    //   * archived_at   -- training_period_charges resolves an ARCHIVED plan to the team default,
    //                      so archiving re-prices every member on it (deleteMembershipPlan
    //                      archives; nothing hard-deletes a plan).
    //   * is_default    -- a member with membership_plan_id IS NULL is billed by whichever plan
    //                      carries the flag, so moving it re-prices all of them at once.
    // Only the trigger is re-issued; membership_plans_pricing_recompute()'s body is unchanged.
    //
    // expires_at stays OUT, deliberately: membership-plan expiry enforcement is a separate
    // concern that must end the whole plan at once, never just its billing (see
    // training_period_charges' own comment). free_trainings_anchor_at stays out too -- every
    // re-stamp is caused by a free_trainings_included change this clause already matches, so
    // watching it buys nothing and would fire off a value the BEFORE trigger wrote in the same
    // statement.
    //
    // New lock leg, checked: setDefaultMembershipPlan holds membership_plans FOR UPDATE
    // (lockTeamPlansQuery) and will now take the fees mutex after it, via is_default. No path
    // takes those in the reverse order -- training_period_charges reads membership_plans with no
    // lock at all, and plain reads never block under READ COMMITTED -- so this adds no 40P01.
    // Do NOT introduce a path that locks membership_plans from inside a fees-holding transaction.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER membership_plans_pricing_recompute_trg
          AFTER UPDATE ON membership_plans
          FOR EACH ROW
          WHEN (NEW.price_per_training_minor IS DISTINCT FROM OLD.price_per_training_minor
                OR NEW.free_trainings_included IS DISTINCT FROM OLD.free_trainings_included
                OR NEW.currency IS DISTINCT FROM OLD.currency
                OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
                OR NEW.is_default IS DISTINCT FROM OLD.is_default)
          EXECUTE FUNCTION membership_plans_pricing_recompute()
      `,
    ),
  ),
);
