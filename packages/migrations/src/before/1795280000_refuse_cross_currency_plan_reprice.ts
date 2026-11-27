import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * 1795270000 refuses moving a paid member to a plan in another currency, but only guards
 * `team_members.membership_plan_id`. Three plan-side writes re-price members without touching that
 * column and double-bill them the same way:
 *   * changing a plan's `currency`            -- its members (and, if it is the default, every
 *                                                member without an own active plan);
 *   * marking another plan `is_default`       -- every member without an own active plan;
 *   * archiving a plan (`archived_at`)        -- its members fall back to the team default.
 * Same refusal, same CONSTRAINT name, so the repositories map it with the same catch.
 *
 * The check is on state, not on a before/after diff: an affected member who has a non-voided
 * payment on a still-open fee (same definition as 1795270000) in a currency OTHER than the one
 * they would now be billed in blocks the write. That sidesteps `setDefaultMembershipPlan`'s
 * two-step clear-then-mark (the clear leaves no default to diff against): only the mark fires,
 * and it knows the target currency. Same-currency changes and unpaid members pass.
 *
 * ponytail: a member already holding paid fees in two currencies (pre-1795270000 leftovers) blocks
 * these writes until the period/season closes; deliberate, settle them first.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION membership_plans_currency_guard() RETURNS trigger AS $$
        DECLARE
          v_cur CHAR(3);
        BEGIN
          IF NEW.archived_at IS NOT NULL THEN
            SELECT mp.currency INTO v_cur FROM membership_plans mp
             WHERE mp.team_id = NEW.team_id AND mp.is_default AND mp.archived_at IS NULL
               AND mp.id <> NEW.id
             LIMIT 1;
          ELSE
            v_cur := NEW.currency;
          END IF;

          IF v_cur IS NOT NULL AND EXISTS (
            SELECT 1
              FROM team_members tm
              JOIN fee_assignments fa ON fa.team_member_id = tm.id
              JOIN fees f ON f.id = fa.fee_id
              JOIN payments p ON p.fee_assignment_id = fa.id
             WHERE tm.team_id = NEW.team_id
               AND (tm.membership_plan_id = NEW.id
                    OR (NEW.is_default AND NEW.archived_at IS NULL AND NOT EXISTS (
                      SELECT 1 FROM membership_plans own
                       WHERE own.id = tm.membership_plan_id AND own.team_id = tm.team_id
                         AND own.archived_at IS NULL)))
               AND f.team_id = NEW.team_id
               AND f.currency <> v_cur
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
            RAISE EXCEPTION 'plan % re-prices members with payments in another currency', NEW.id
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
        CREATE OR REPLACE TRIGGER membership_plans_currency_guard_trg
          BEFORE UPDATE OF currency, is_default, archived_at ON membership_plans
          FOR EACH ROW
          WHEN (NEW.currency IS DISTINCT FROM OLD.currency
                OR (NEW.is_default AND NOT OLD.is_default)
                OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL))
          EXECUTE FUNCTION membership_plans_currency_guard()
      `,
    ),
  ),
);
