import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * A member who has PAID something on their current plan's still-open fees cannot be moved onto a
 * plan in a DIFFERENT currency. Without this, the recompute leaves the paid old-currency
 * assignment standing (S3 clamps it to paid_minor, S4 refuses to delete a paid row) and bills the
 * member again in the new currency -- two open rows, two currencies, one month.
 *
 * Product decision: refuse, never convert, never mint credit. The treasurer settles or clears the
 * old plan's payments first. Same-currency moves and members with no payments are untouched.
 *
 * A trigger, not a guard in each repository UPDATE, for the same reason 1793600000 is one: three
 * methods write the column (`selectMembershipPlan`, `assignMembershipPlan`,
 * `reassignMembershipPlan`) and every future writer is covered too. The repositories catch the
 * named CONSTRAINT below and turn it into a typed error. A bulk move containing one blocked
 * member fails as a whole -- the statement is atomic, so nobody is half-moved.
 *
 * "Still open" = exactly what the recomputes re-price: the CURRENT training period's
 * `kind = 'training'` fee (`team_members_plan_recompute_trg`) and the CURRENT season's
 * `kind = 'membership'` fee (`recompute_membership_season_fees`' own season pick, restated). A
 * payment on a closed period or an earlier season is frozen history and does not block anything.
 *
 * The effective plan restates `membership_season_charges`' resolution: the member's own active,
 * same-team plan, else the team default. A NULL old currency (no plan at all) cannot owe anything.
 *
 * ponytail: plain reads, no lock -- a payment committed concurrently with the move can slip past.
 * Same window as "move, then pay"; add `FOR SHARE` on the payments only if it is ever observed.
 * Changing a plan's OWN currency or flipping the default re-prices members without touching
 * `team_members` and is not covered here.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION team_members_plan_currency_guard() RETURNS trigger AS $$
        DECLARE
          v_old CHAR(3);
          v_new CHAR(3);
        BEGIN
          SELECT x.currency INTO v_old FROM (
            SELECT mp.currency, 0 AS rank FROM membership_plans mp
             WHERE mp.id = OLD.membership_plan_id AND mp.team_id = OLD.team_id
               AND mp.archived_at IS NULL
            UNION ALL
            SELECT mp.currency, 1 FROM membership_plans mp
             WHERE mp.team_id = OLD.team_id AND mp.is_default AND mp.archived_at IS NULL
          ) x ORDER BY x.rank LIMIT 1;

          SELECT x.currency INTO v_new FROM (
            SELECT mp.currency, 0 AS rank FROM membership_plans mp
             WHERE mp.id = NEW.membership_plan_id AND mp.team_id = NEW.team_id
               AND mp.archived_at IS NULL
            UNION ALL
            SELECT mp.currency, 1 FROM membership_plans mp
             WHERE mp.team_id = NEW.team_id AND mp.is_default AND mp.archived_at IS NULL
          ) x ORDER BY x.rank LIMIT 1;

          IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new AND EXISTS (
            SELECT 1
              FROM payments p
              JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
              JOIN fees f ON f.id = fa.fee_id
             WHERE fa.team_member_id = NEW.id
               AND f.team_id = NEW.team_id
               AND f.currency = v_old
               AND f.archived_at IS NULL
               AND p.voided_at IS NULL
               AND (
                 (f.kind = 'training'
                   AND f.period_start = training_period_start(now(), NEW.team_id))
                 OR (f.kind = 'membership' AND f.season_id = (
                   SELECT s.id FROM seasons s
                    WHERE s.team_id = NEW.team_id AND s.starts_at <= now()
                    ORDER BY s.starts_at DESC LIMIT 1))
               )
          ) THEN
            RAISE EXCEPTION 'member % has % payments on the current plan', NEW.id, v_old
              USING ERRCODE = 'check_violation',
                    CONSTRAINT = 'team_members_plan_currency_has_payments';
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER team_members_plan_currency_guard_trg
          BEFORE UPDATE OF membership_plan_id ON team_members
          FOR EACH ROW
          WHEN (OLD.membership_plan_id IS DISTINCT FROM NEW.membership_plan_id)
          EXECUTE FUNCTION team_members_plan_currency_guard()
      `,
    ),
  ),
);
