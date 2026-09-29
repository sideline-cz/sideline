import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * SUPERSEDED by 1793500000: the allowance became ALL-TIME. The "needs a consumption ledger"
 * argument below was resolved by re-deriving prior consumption from attendance, not by storing
 * state; the anchor is membership_plans.free_trainings_anchor_at.
 *
 * A membership plan may include N trainings at no charge. The allowance is PER BILLING PERIOD
 * (the same calendar month `training_period_start` already defines), never a lifetime quota: a
 * lifetime quota would need a consumption ledger recording which attendance rows burned it,
 * which `recompute_training_period_fees` cannot have -- that function is idempotent and
 * recomputes a whole period from scratch on every attendance write, so any "already spent"
 * state it wrote would be re-derived and double-counted. Per-period stays one column and zero
 * new state.
 *
 * Plan switch mid-period (reachable since #744): the member's CURRENT plan applies to the whole
 * period. This is not a new rule -- `price_per_training_minor` already behaves exactly this way,
 * because `training_period_charges` resolves the plan at recompute time and has no record of
 * what it was earlier in the month. Prorating the allowance but not the price would be
 * incoherent, and there is no plan-assignment history to prorate against.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE membership_plans
          ADD COLUMN IF NOT EXISTS free_trainings_per_period INT NOT NULL DEFAULT 0
            CHECK (free_trainings_per_period >= 0)
      `,
    ),

    // ---- the charge, with the allowance applied ------------------------------------------
    // Replaces 1793200000's definition verbatim except for the allowance. Kept as a full
    // CREATE OR REPLACE (not a patch) because that is the only way plpgsql/sql functions are
    // updated; read the two together.
    //
    // GREATEST(..., 0) is load-bearing: an allowance larger than the month's attendance would
    // otherwise produce a NEGATIVE amount_minor, which `fee_assignments`' own CHECK rejects and
    // which S3 would try to write on every recompute -- the trigger would start raising on
    // ordinary attendance confirmation.
    //
    // No CHECK ties the allowance to `price_per_training_minor > 0`: on a free plan the gate
    // below already makes the allowance a no-op, and a constraint would reject the legitimate
    // "set the allowance, then set the price" edit order.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION training_period_charges(p_team_id UUID, p_period_start DATE)
        RETURNS TABLE (team_member_id UUID, currency CHAR(3), amount_minor BIGINT)
        LANGUAGE sql STABLE
        AS $$
          -- No expires_at check here: membership-plan expiry enforcement is out of scope for
          -- this slice. price_per_training_minor > 0 is the opt-in gate -- a free default plan
          -- yields zero rows, so a team that never priced training gets zero fees, ever.
          SELECT
            tm.id AS team_member_id,
            plan.currency,
            (plan.price_per_training_minor
               * GREATEST(COUNT(*) - plan.free_trainings_per_period, 0))::bigint AS amount_minor
          FROM team_members tm
          JOIN events e
            ON e.team_id = p_team_id
           AND e.event_type = 'training'
           AND e.status <> 'cancelled'
           -- Sargable, TIMEZONE-INDEPENDENT pre-filter for idx_events_team_date. A bare
           -- (p_period_start - 1)::timestamptz promotes at the SESSION TimeZone, and any
           -- session TZ at or east of +12 then silently drops the last half-day of every
           -- month -- a silent undercharge with no error. The exact equality below is the
           -- real predicate; these bounds exist only so the index is usable.
           AND e.start_at >= (p_period_start - INTERVAL '1 day') AT TIME ZONE 'UTC'
           AND e.start_at <  (p_period_start + INTERVAL '1 month 1 day') AT TIME ZONE 'UTC'
           AND training_period_start(e.start_at, e.team_id) = p_period_start
          JOIN event_attendance ea
            ON ea.event_id = e.id
           AND ea.team_member_id = tm.id
           AND ea.confirmed_at IS NOT NULL
           AND ea.present
          CROSS JOIN LATERAL (
            -- The member's own plan, scoped to THIS team. Nothing prevents a team_members row
            -- from naming another team's plan (1792900000_membership_selection.ts's own
            -- comment) -- without the team_id scope here a member would be charged another
            -- club's price, in another club's currency.
            SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_per_period
            FROM membership_plans mp
            WHERE mp.id = tm.membership_plan_id
              AND mp.team_id = tm.team_id
              AND mp.archived_at IS NULL
            UNION ALL
            SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_per_period
            FROM membership_plans mp
            WHERE mp.team_id = tm.team_id
              AND mp.is_default
              AND mp.archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM membership_plans mp2
                WHERE mp2.id = tm.membership_plan_id
                  AND mp2.team_id = tm.team_id
                  AND mp2.archived_at IS NULL
              )
            LIMIT 1
          ) plan
          WHERE tm.team_id = p_team_id
            AND plan.price_per_training_minor > 0
          GROUP BY tm.id, plan.currency, plan.price_per_training_minor,
                   plan.free_trainings_per_period
          -- A member fully covered by their allowance is NOT emitted at all. Dropping them here
          -- rather than emitting a 0 row is what stops S0 from creating an empty fees shell
          -- for a period nobody owes anything in (shells are never deleted). An EXISTING
          -- assignment that falls to zero is still handled: S3 LEFT JOINs this function, so the
          -- missing row zeroes it via COALESCE and S4 prunes it.
          HAVING COUNT(*) > plan.free_trainings_per_period
        $$
      `,
    ),

    // ---- recompute the OPEN period when a plan's pricing changes ---------------------------
    // Without this a captain who sets "4 free trainings" sees no change to the month's fee
    // until the next attendance write -- the feature reads as broken. A trigger, not a
    // repository call, so every writer of the column is covered (the update endpoint today,
    // whatever writes it tomorrow).
    //
    // Past periods are NOT re-priced: `recompute_training_period_fees` returns early for any
    // period before the current one, so a settled month cannot be reopened by a late plan edit.
    // That guard is the reason this trigger is safe to fire unconditionally.
    //
    // Only the two columns that feed `training_period_charges` are watched -- renaming a plan or
    // moving its expiry must not touch money.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION membership_plans_pricing_recompute() RETURNS trigger AS $$
        BEGIN
          PERFORM recompute_training_period_fees(
            NEW.team_id, training_period_start(now(), NEW.team_id)
          );
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER membership_plans_pricing_recompute_trg
          AFTER UPDATE ON membership_plans
          FOR EACH ROW
          WHEN (NEW.price_per_training_minor IS DISTINCT FROM OLD.price_per_training_minor
                OR NEW.free_trainings_per_period IS DISTINCT FROM OLD.free_trainings_per_period)
          EXECUTE FUNCTION membership_plans_pricing_recompute()
      `,
    ),
  ),
);
