import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * The free-training allowance shipped by 1793400000 was PER BILLING PERIOD and reset every month.
 * The requirement is an ALL-TIME allowance: a plan includes N free trainings a member consumes
 * once, never reset while the membership is active.
 *
 * Blast radius is zero (every production row is 0, `event_attendance` is empty, no
 * `kind = 'training'` fee exists), so the column is renamed in place rather than dual-written.
 *
 * "Already consumed" needs no ledger: it is a COUNT of the member's attendance in periods
 * at-or-after the plan's anchor period and before the period being recomputed, re-derived from
 * scratch on every call, which keeps `training_period_charges` STABLE and idempotent.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- 1.1 rename the column -------------------------------------------------------------
    // ALTER TABLE ... RENAME COLUMN has no IF EXISTS form; guard it so a local re-run is a no-op.
    //
    // The CHECK (... >= 0) expression follows the column (pg_constraint.conbin is a node tree).
    // Its auto-generated NAME does not change -- leave it; nothing asserts on it and renaming it
    // is diff noise. membership_plans_pricing_recompute_trg's WHEN clause also follows
    // (pg_trigger.tgqual is a node tree), so that trigger is deliberately NOT re-issued.
    // training_period_charges' body does NOT follow -- prosrc is stored as text, which is why it
    // is replaced in full below.
    Effect.tap(
      () => sql`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'membership_plans'
              AND column_name = 'free_trainings_per_period'
          ) THEN
            ALTER TABLE membership_plans
              RENAME COLUMN free_trainings_per_period TO free_trainings_included;
          END IF;
        END
        $$
      `,
    ),

    // ---- 1.2 the anchor column -------------------------------------------------------------
    // Three statements, not ADD COLUMN ... NOT NULL DEFAULT now(): PG's fast-path
    // ADD COLUMN ... DEFAULT only applies to non-volatile defaults, so the one-liner forces a
    // table rewrite. Splitting it also makes the backfill re-runnable.
    //
    // DEFAULT now() covers the INSERT path -- a plan created WITH an allowance is anchored at its
    // own creation and needs no trigger. Both writers omit the column from their explicit column
    // lists (MembershipPlansRepository, seed_default_membership_plan), so both take the default.
    //
    // The column is INTERNAL: nothing reads it outside training_period_charges, so it is
    // deliberately not added to any domain schema.
    Effect.tap(
      () => sql`
        ALTER TABLE membership_plans
          ADD COLUMN IF NOT EXISTS free_trainings_anchor_at TIMESTAMPTZ
      `,
    ),
    Effect.tap(
      () => sql`
        -- Backfill guarded on the FACT that the column is unset, never on a value predicate
        -- (migrations AGENTS.md, "Reinterpreting Stored Values"). created_at is the only sane
        -- seed: every existing row has free_trainings_included = 0, so the anchor is unreachable
        -- until a manager sets an allowance, and the BEFORE trigger below re-stamps it at that
        -- moment. A re-run of an UNGUARDED update would silently reset an already-stamped anchor.
        UPDATE membership_plans SET free_trainings_anchor_at = created_at
        WHERE free_trainings_anchor_at IS NULL
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE membership_plans
          ALTER COLUMN free_trainings_anchor_at SET NOT NULL,
          ALTER COLUMN free_trainings_anchor_at SET DEFAULT now()
      `,
    ),

    // ---- 1.3 the re-stamp trigger ----------------------------------------------------------
    // The anchor is NOT created_at: the default plan is seeded at TEAM creation (1792800000) and
    // every member sits on it, so a club that trained for months and then priced that plan would
    // have every member's prior consumption already above N -- nobody would ever get the
    // allowance. Stamping at the moment a manager first grants a non-zero allowance is when
    // "your N free trainings start" actually means something to a member.
    //
    // Lowering (5 -> 3) and clearing (4 -> 0) deliberately do NOT re-stamp: lowering would hand a
    // fresh 3 to members who already burned all 5. Raising 2 -> 5 does not re-stamp either --
    // the budget rises to 5, the 2 already burned still count, so free_left = 3.
    //
    // The AFTER trigger membership_plans_pricing_recompute_trg must NOT start watching
    // free_trainings_anchor_at: every re-stamp is CAUSED by a free_trainings_included change its
    // WHEN clause already matches, so watching the anchor buys nothing and would make a
    // non-money column take the team-wide fees mutex.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION membership_plans_stamp_free_trainings_anchor() RETURNS trigger AS $$
        BEGIN
          -- BEFORE, not AFTER: an AFTER trigger cannot assign NEW.*. Assigning NEW in place is
          -- not a recursive write, so there is no recursion guard to add. The whole condition
          -- lives in the trigger's WHEN clause so pg_get_triggerdef is self-documenting.
          NEW.free_trainings_anchor_at := now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER membership_plans_stamp_free_trainings_anchor_trg
          BEFORE UPDATE ON membership_plans
          FOR EACH ROW
          WHEN (OLD.free_trainings_included = 0 AND NEW.free_trainings_included > 0)
          EXECUTE FUNCTION membership_plans_stamp_free_trainings_anchor()
      `,
    ),

    // ---- 1.4 the charge, with the ALL-TIME allowance applied -------------------------------
    // Arity is unchanged (UUID, DATE). Do not change the signature for any reason --
    // CREATE OR REPLACE with a different argument count creates a SECOND function and silently
    // leaves the old body live.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION training_period_charges(p_team_id UUID, p_period_start DATE)
        RETURNS TABLE (team_member_id UUID, currency CHAR(3), amount_minor BIGINT)
        LANGUAGE sql STABLE
        AS $$
          -- The allowance is ALL-TIME, not per billing period: a plan includes N free trainings that a
          -- member consumes ONCE. No ledger and no per-attendance state -- "already consumed" is a COUNT
          -- of the member's attendance in EARLIER periods, re-derived from scratch on every call, so the
          -- function stays STABLE and idempotent.
          --
          -- ANCHOR = membership_plans.free_trainings_anchor_at, NOT created_at and NOT a per-member
          -- assignment timestamp.
          --   * Not created_at: the default plan is seeded at TEAM creation (1792800000) and every member
          --     sits on it, so a club that trained for months and then priced that plan would have every
          --     member's prior already above N -- nobody would ever get the allowance. The anchor column is
          --     re-stamped by membership_plans_stamp_free_trainings_anchor_trg at the moment a manager
          --     first sets a non-zero allowance, which is when "your N free trainings start" actually means
          --     something to a member.
          --   * Not a per-member column: selectMembershipPlan is member SELF-SERVICE and
          --     membership_selection_deadline defaults to NULL/always-open, so a per-member anchor would be
          --     farmable by toggling plans. This one is plan-level and manager-only.
          -- Known, accepted leak: a manager archiving and recreating a plan, creating a brand-new one, or
          -- setting the allowance to 0 and back re-anchors everyone on it. All manager-only and visible.
          --
          -- No expires_at check here: membership-plan expiry enforcement is a separate concern and must end
          -- the WHOLE plan at once, never just the allowance. price_per_training_minor > 0 is the opt-in
          -- gate -- a free default plan yields zero rows, so a team that never priced training gets zero
          -- fees, ever.
          WITH in_period AS (
            SELECT
              tm.id AS team_member_id,
              plan.currency,
              plan.price_per_training_minor,
              plan.free_trainings_included,
              plan.free_trainings_anchor_at AS plan_anchor_at,
              -- Computed ONCE per member, not per candidate row in the prior scan below.
              -- training_period_start runs a SELECT against team_settings on every call, and a call whose
              -- team argument is a Var of the scanned relation is a per-row qual with no memoisation --
              -- that would double the team_settings probes on the hottest new scan in this PR. No extra
              -- GROUP BY entry is needed: the expression is built only from a grouped column and a
              -- function parameter. p_team_id is the same team as the prior scan's pe.team_id, which that
              -- scan pins with pe.team_id = p_team_id.
              training_period_start(plan.free_trainings_anchor_at, p_team_id) AS plan_anchor_period,
              COUNT(*) AS attended
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
              -- The member's own plan, scoped to THIS team. Nothing prevents a team_members row from
              -- naming another team's plan (1792900000_membership_selection.ts's own comment) -- without
              -- the team_id scope here a member would be charged another club's price, in another club's
              -- currency. free_trainings_anchor_at is selected in BOTH branches: it is the allowance
              -- anchor, and a UNION ALL with mismatched column lists would not even parse.
              SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_included,
                     mp.free_trainings_anchor_at
              FROM membership_plans mp
              WHERE mp.id = tm.membership_plan_id
                AND mp.team_id = tm.team_id
                AND mp.archived_at IS NULL
              UNION ALL
              SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_included,
                     mp.free_trainings_anchor_at
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
                     plan.free_trainings_included, plan.free_trainings_anchor_at
          )
          SELECT
            p.team_member_id,
            p.currency,
            (p.price_per_training_minor * GREATEST(p.attended - f.free_left, 0))::bigint AS amount_minor
          FROM in_period p
          CROSS JOIN LATERAL (
            -- How much allowance is LEFT when this period starts: the plan's allowance minus everything the
            -- member already burned in EARLIER periods.
            --
            -- PERIOD-ALIGNED, NOT INSTANT-ALIGNED, and this is the whole correctness argument. in_period
            -- above counts a WHOLE period with no anchor filter. If the floor here were the anchor INSTANT,
            -- the two sets would not partition: trainings in the anchor's own month that happened before
            -- the stamp would be covered by that month's pass and then vanish from the next month's prior,
            -- handing the member a second full allowance. Comparing training_period_start on both sides
            -- makes the two sets meet exactly at the period boundary. Consequence, deliberate: the anchor's
            -- own month counts in full, including trainings from before the manager set the allowance.
            --
            -- The two start_at bounds are LOOSE sargable floors/ceilings for idx_events_team_date only; the
            -- two period comparisons are the real predicates. 32 days covers the longest month plus the
            -- widest IANA offset. The upper bound is safe for the whole IANA range (-12..+14): an event
            -- whose TEAM-LOCAL period is before p_period_start has a UTC instant strictly below
            -- p_period_start + 1 day (worst case -12 puts local midnight at +12h UTC).
            --
            -- The CASE is a COST guard, not a semantic one: with a 0 allowance the scan's answer is
            -- provably GREATEST(0 - n, 0) = 0, and a scalar subquery inside CASE is only evaluated when
            -- its branch is taken. That is the configuration of every plan shipped today, so the whole
            -- history scan is skipped for them. Measured on PG17, 30 members x 3 years (534 trainings,
            -- 16 020 attendance rows), allowance 0: 142 ms -> 3.5 ms per call, and a 20-member squad
            -- confirm 8.3 s -> ~0.2 s -- all of it inside S1's team-wide fees mutex. Identical results
            -- (same row count, same sum(amount_minor)). No assertion can observe cost, so this comment
            -- is the pin: do NOT flatten the CASE back into a plain subquery.
            --
            -- p_team_id, not pe.team_id, in both training_period_start calls: the WHERE above pins
            -- pe.team_id = p_team_id on every row, so they are the same value, but only the parameter
            -- form lets the team_settings probe fold into a once-per-execution InitPlan instead of a
            -- per-row correlated SubPlan.
            SELECT CASE WHEN p.free_trainings_included = 0 THEN 0 ELSE (
              SELECT GREATEST(p.free_trainings_included - COUNT(*), 0)
              FROM events pe
              JOIN event_attendance pea
                ON pea.event_id = pe.id
               AND pea.team_member_id = p.team_member_id
               AND pea.confirmed_at IS NOT NULL
               AND pea.present
              WHERE pe.team_id = p_team_id
                AND pe.event_type = 'training'
                AND pe.status <> 'cancelled'
                AND pe.start_at >= p.plan_anchor_at - INTERVAL '32 days'
                AND pe.start_at <  (p_period_start + INTERVAL '1 day') AT TIME ZONE 'UTC'
                AND training_period_start(pe.start_at, p_team_id) >= p.plan_anchor_period
                AND training_period_start(pe.start_at, p_team_id) < p_period_start
            ) END AS free_left
          ) f
          -- THIS is what stops a negative amount_minor: a member fully covered by their remaining allowance
          -- is not emitted at all. Dropping them rather than emitting a 0 row is also what stops S0
          -- creating an empty fees shell for a period nobody owes anything in (shells are never deleted).
          -- An EXISTING assignment that falls to zero is still handled: S3 LEFT JOINs this function, so the
          -- missing row zeroes it via COALESCE and S4 prunes it.
          WHERE p.attended > f.free_left
        $$
      `,
    ),

    // ---- 1.5 attendance writes must also move the CURRENT period ---------------------------
    // Full replacement of 1793200000's version. The IF v_period < v_now_period guard is strictly
    // ascending, so this function needs no loop. The trigger
    // event_attendance_training_recompute_trg is unchanged and deliberately not re-issued.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION event_attendance_training_recompute() RETURNS trigger AS $$
        DECLARE
          v_event_id UUID;
          v_team_id UUID;
          v_start_at TIMESTAMPTZ;
          v_period DATE;
          v_now_period DATE;
        BEGIN
          -- Nothing billing-relevant changed -- same shape as events_training_recompute below. Before
          -- this migration a past-period attendance write early-returned inside
          -- recompute_training_period_fees and cost nothing; now it also recomputes the CURRENT period
          -- and takes the team-wide fees mutex, so a write that moves no money must not get that far.
          -- The two paths this protects are both plain FK cascades, one row at a time:
          -- event_attendance.confirmed_by is ON DELETE SET NULL (deleting a captain UPDATEs every row
          -- they ever confirmed) and event_attendance.team_member_id is ON DELETE CASCADE (removing a
          -- member DELETEs a season of rows inside the member-delete transaction). Only UPDATE is
          -- filtered: INSERT and DELETE always change the counts.
          IF TG_OP = 'UPDATE'
             AND NEW.present IS NOT DISTINCT FROM OLD.present
             AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
             AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
             AND NEW.team_member_id IS NOT DISTINCT FROM OLD.team_member_id THEN
            RETURN NEW;
          END IF;

          v_event_id := COALESCE(NEW.event_id, OLD.event_id);
          SELECT e.team_id, e.start_at INTO v_team_id, v_start_at
          FROM events e WHERE e.id = v_event_id;
          IF v_team_id IS NULL THEN
            RETURN COALESCE(NEW, OLD);
          END IF;
          v_period := training_period_start(v_start_at, v_team_id);
          PERFORM recompute_training_period_fees(v_team_id, v_period);

          -- The allowance is ALL-TIME, so changing attendance in a PAST period shifts the CURRENT period's
          -- free_left. recompute_training_period_fees early-returns on a past period, so without the second
          -- call below a correction to a settled month would move nothing at all, anywhere.
          --
          -- Strict < is both the dedup (never recompute the current period twice) and the lock ordering:
          -- the two calls are period-ASCENDING, which is the total order every path in this file keeps.
          -- A FUTURE-dated period is deliberately not covered -- its free_left can be stale until the next
          -- write, which is accepted.
          --
          -- The confirmed_at disjunction suppresses PRE-TICKS ONLY -- a row that is unconfirmed on both
          -- sides contributes to neither count, so it cannot move money. It does NOT bound the cost of a
          -- bulk confirm: confirmAttendance stamps confirmed_at, so all 20 rows of a squad confirmation
          -- pass this test and each fires its own current-period recompute (three
          -- training_period_charges calls, S0/S2/S3). It does not test present either, so a confirmed
          -- present=false row also gets through. OLD is in the disjunction because UN-confirming is
          -- exactly the case that must move money.
          --
          -- Side benefit, worth keeping: before this, a past-period attendance write took NO fees lock at
          -- all (it early-returned before S1), so it could commit mid-recompute of the current period and
          -- land between S2's and S3's separate snapshots. Now it blocks on the current period's S1 mutex.
          v_now_period := training_period_start(now(), v_team_id);
          IF v_period < v_now_period
             AND (NEW.confirmed_at IS NOT NULL OR OLD.confirmed_at IS NOT NULL) THEN
            PERFORM recompute_training_period_fees(v_team_id, v_now_period);
          END IF;

          RETURN COALESCE(NEW, OLD);
        END;
        $$ LANGUAGE plpgsql
      `,
    ),

    // ---- 1.6 event writes must also move the CURRENT period --------------------------------
    // The shipped IF/ELSE is period-ascending on every path, and that is the property that must
    // survive. It does NOT survive "handle old/new, then append the current period last":
    // whenever either period is in the FUTURE the appended call is a step backwards, and
    // recompute_training_period_fees only early-returns on periods BEFORE the current one -- a
    // future period DOES take the S1 fees mutex. fees.id is gen_random_uuid(), so the canonical
    // "fees by id ASC" rule gives no cross-period guarantee; period-ascending is the only total
    // order available. The trigger events_training_recompute_trg is unchanged.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION events_training_recompute() RETURNS trigger AS $$
        DECLARE
          v_has_attendance BOOLEAN;
          v_old_period DATE;
          v_new_period DATE;
          v_now_period DATE;
          v_p DATE;
        BEGIN
          IF NEW.status IS NOT DISTINCT FROM OLD.status
             AND NEW.start_at IS NOT DISTINCT FROM OLD.start_at
             AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
             AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
            RETURN NEW;
          END IF;

          -- This EXISTS check MUST precede any lock, so an ordinary reschedule of a training with no
          -- confirmed attendance yet stays lock-free.
          SELECT EXISTS(
            SELECT 1 FROM event_attendance ea
            WHERE ea.event_id = NEW.id AND ea.confirmed_at IS NOT NULL AND ea.present
          ) INTO v_has_attendance;
          IF NOT v_has_attendance THEN
            RETURN NEW;
          END IF;

          v_old_period := training_period_start(OLD.start_at, OLD.team_id);
          v_new_period := training_period_start(NEW.start_at, NEW.team_id);
          -- The allowance is ALL-TIME: retyping, cancelling or moving a training in a PAST period changes
          -- how much allowance is already burned, which shifts the CURRENT period's charge. Both period
          -- recomputes below early-return on a past period, so nothing would move without this third one.
          v_now_period := training_period_start(now(), OLD.team_id);

          -- ONE period-ASCENDING pass over all three periods, deduped. Ascending is the only total order
          -- available: recompute_training_period_fees early-returns on PAST periods only, so a FUTURE
          -- period does take the S1 fees mutex, and fees.id is gen_random_uuid() so the canonical id-ASC
          -- rule carries no cross-period guarantee. Do NOT go back to "handle old/new, then append now" --
          -- that ordering steps backwards whenever either period is in the future, and it deadlocks (40P01)
          -- against an ordinary current -> future reschedule on the same team.
          FOR v_p IN
            SELECT DISTINCT p FROM (VALUES (v_old_period), (v_new_period), (v_now_period)) AS t(p)
            ORDER BY p
          LOOP
            -- OLD.team_id owns v_old_period and v_now_period. On a CROSS-TEAM move it does NOT own
            -- v_new_period: training_period_charges joins tm.team_id = p_team_id, and a moved event's
            -- attendance rows point at OLD.team_id's team_members, so recomputing v_new_period for
            -- OLD.team_id is a pure no-op -- one that would take a SECOND cross-team fees lock and widen
            -- the pre-existing 40P01 window (Risk 3) from same-period to any-period. This guard is the
            -- reason that window is not widened.
            IF NEW.team_id = OLD.team_id OR v_p = v_old_period OR v_p = v_now_period THEN
              PERFORM recompute_training_period_fees(OLD.team_id, v_p);
            END IF;
            -- OLD before NEW inside a slot, matching the shipped code's team order.
            IF v_p = v_new_period AND NEW.team_id <> OLD.team_id THEN
              PERFORM recompute_training_period_fees(NEW.team_id, v_p);
            END IF;
          END LOOP;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
  ),
);
