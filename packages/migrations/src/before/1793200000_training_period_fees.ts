import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Slice 3b of "Setup memberships" — turns confirmed attendance (`event_attendance`, #732) into
 * money, using `membership_plans.price_per_training_minor` (#729, read by nothing until now).
 *
 * ONE `fees` row per (team, calendar month, currency), never one row per training. A
 * per-training-charge shape was designed, reviewed and REJECTED: it made reminders impossible
 * (the reminder CTEs and `findByTeamMember` all key off `fees`/`fee_assignments`), killed bank
 * auto-matching (one exact-amount candidate per member per period is what makes
 * `matchDecision`'s auto-match safe) and hid charges from the fees page. Do not reintroduce it.
 *
 * Money math already lives in a migration — `recompute_paid_minor` in
 * `1783000000_create_finance.ts` is the precedent this follows.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- DDL --------------------------------------------------------------
    Effect.tap(
      () => sql`
        ALTER TABLE fees
          ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual'
            CHECK (kind IN ('manual','training'))
      `,
    ),
    Effect.tap(() => sql`ALTER TABLE fees ADD COLUMN IF NOT EXISTS period_start DATE`),
    Effect.tap(
      () => sql`
        ALTER TABLE fees DROP CONSTRAINT IF EXISTS fees_kind_period_start_check
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE fees
          ADD CONSTRAINT fees_kind_period_start_check
          CHECK ((kind = 'training') = (period_start IS NOT NULL))
      `,
    ),
    // One fee shell per (team, period, currency) — the cardinality the rest of this migration
    // relies on. The ON CONFLICT in recompute_training_period_fees restates this WHERE clause;
    // a partial unique index is only inferable when the predicate is restated (42P10 otherwise).
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fees_team_period_currency
          ON fees (team_id, period_start, currency) WHERE kind = 'training'
      `,
    ),
    // Recreated to stay a covering index for the existing fee-list query now that 'training'
    // fees exist: that query only ever wants the manual fees a treasurer created by hand.
    Effect.tap(() => sql`DROP INDEX IF EXISTS idx_fees_team_active`),
    Effect.tap(
      () => sql`
        CREATE INDEX idx_fees_team_active
          ON fees(team_id) WHERE archived_at IS NULL AND kind = 'manual'
      `,
    ),

    // ---- FUNCTION 1: the team-local calendar month a training instant falls in -------------
    // team_settings is a one-to-one extension that may not exist for a team; COALESCE handles
    // it. Its timezone column is CHECK-validated since 1792000005_team_settings_timezone_check,
    // so `AT TIME ZONE` here can never raise.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION training_period_start(p_start_at TIMESTAMPTZ, p_team_id UUID)
        RETURNS DATE
        LANGUAGE sql STABLE
        AS $$
          SELECT (date_trunc('month', p_start_at AT TIME ZONE COALESCE(
            (SELECT ts.timezone FROM team_settings ts WHERE ts.team_id = p_team_id), 'UTC'
          )))::date
        $$
      `,
    ),

    // ---- FUNCTION 2: what each member owes for one (team, period) -------------------------
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
            (plan.price_per_training_minor * COUNT(*))::bigint AS amount_minor
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
            SELECT mp.currency, mp.price_per_training_minor
            FROM membership_plans mp
            WHERE mp.id = tm.membership_plan_id
              AND mp.team_id = tm.team_id
              AND mp.archived_at IS NULL
            UNION ALL
            SELECT mp.currency, mp.price_per_training_minor
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
          GROUP BY tm.id, plan.currency, plan.price_per_training_minor
        $$
      `,
    ),

    // ---- FUNCTION 3: the writer. One fees row per (team, period, currency); its
    // fee_assignments frozen to the current charge, clamped, created and pruned. --------------
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION recompute_training_period_fees(p_team_id UUID, p_period_start DATE)
        RETURNS void AS $$
        DECLARE
          v_tz TEXT;
          v_due_at TIMESTAMPTZ;
        BEGIN
          -- PERIOD CLOSE is on the calendar date, never archived_at. Closing via archived_at
          -- was the original plan and it is broken: both reminder CTEs in
          -- FeeAssignmentsRepository require f.archived_at IS NULL, and findByTeamMember hides
          -- archived unpaid fees -- so archiving to "close" the period means the member is
          -- NEVER told they owe it, anywhere. Closing on the date instead freezes the amount
          -- once the month is over, leaves archived_at meaning what it means everywhere else,
          -- and lets the full reminder ladder run on the frozen amount. It also stops a late
          -- correction from reopening a settled month -- which would otherwise turn that
          -- member's bank auto-matching off indefinitely (a settled month reopening creates a
          -- second open candidate, and matchDecision only auto-matches on an exact single
          -- match).
          IF p_period_start < training_period_start(now(), p_team_id) THEN
            RETURN;
          END IF;

          SELECT ts.timezone INTO v_tz FROM team_settings ts WHERE ts.team_id = p_team_id;
          IF NOT FOUND OR v_tz IS NULL THEN
            v_tz := 'UTC';
          END IF;

          -- The 10th of the month AFTER the period, local midnight. Set ON INSERT ONLY (S0)
          -- so a treasurer's own edit to due_at sticks -- S3 never touches it.
          v_due_at := (p_period_start + INTERVAL '1 month' + INTERVAL '9 days')::timestamp
                        AT TIME ZONE v_tz;

          -- S0: create the fee shell(s) for this period, one per currency in use.
          INSERT INTO fees (team_id, kind, period_start, name, amount_minor, currency, due_at, target_scope)
          SELECT DISTINCT p_team_id, 'training', p_period_start, to_char(p_period_start, 'YYYY-MM'),
                 0, c.currency, v_due_at, 'custom'
          FROM training_period_charges(p_team_id, p_period_start) c
          ON CONFLICT (team_id, period_start, currency) WHERE kind = 'training' DO NOTHING;

          -- S1 is DEFENSIVE, not a fix for a demonstrated race. Removing it was measured against a
          -- two-session same-member test and that test stayed green: the UNIQUE (fee_id,
          -- team_member_id) constraint serialises the first insert, and S3's FOR UPDATE OF fa
          -- serialises every later one. It is kept because it gives S0-S4 one view of the period,
          -- not because a lost update was observed. See AGENTS.md invariant 2.
          -- S1: THE MUTEX for this whole function -- a fees FOR UPDATE, id ASC (see AGENTS.md's
          -- canonical lock order). MUST come AFTER S0 so a concurrent creator has already been
          -- serialised by the unique index and its row is visible to this fresh READ COMMITTED
          -- snapshot. Deliberately NOT filtered on currency -- a member whose plan currency
          -- changed mid-month leaves a stale assignment under the OLD currency's fee, and only
          -- an unfiltered S1/S3 will zero and remove it.
          PERFORM 1 FROM fees f
           WHERE f.team_id = p_team_id AND f.kind = 'training' AND f.period_start = p_period_start
             AND f.archived_at IS NULL
           ORDER BY f.id FOR UPDATE;

          -- S2: create any missing assignments. Creation only -- never DO UPDATE here, S3 owns
          -- every update.
          INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
          SELECT f.id, c.team_member_id, c.amount_minor
          FROM training_period_charges(p_team_id, p_period_start) c
          JOIN fees f ON f.team_id = p_team_id AND f.kind = 'training'
                     AND f.period_start = p_period_start
                     AND f.currency = c.currency AND f.archived_at IS NULL
          ON CONFLICT (fee_id, team_member_id) DO NOTHING;

          -- S3: freeze every existing assignment to the current charge. GREATEST(...,
          -- paid_minor) IS A CORRECTION AND IS LOAD-BEARING: without it a downward correction
          -- can leave amount_minor < paid_minor, and
          -- applications/web/src/components/pages/FinancesOverviewPage.tsx does a RAW
          -- subtraction (totalDueMinor - totalPaidMinor) both per member and in a team-wide
          -- reduce, so one overpaid member would silently UNDERSTATE THE WHOLE TEAM's
          -- outstanding KPI. The clamp makes amount_minor < paid_minor structurally
          -- unreachable. It also avoids stranding money that is neither outstanding nor credit
          -- nor refundable (settle skips amount_minor > paid_minor forever).
          --
          -- MATERIALIZED is load-bearing: the CTE must execute in full so every row is locked
          -- in id order, including rows the outer UPDATE's join would otherwise prune. LEFT
          -- JOIN (never inner) so a now-zero-charge row is still locked and zeroed. SET
          -- touches ONLY amount_minor and updated_at -- never stored_status, never due_at.
          WITH locked AS MATERIALIZED (
            SELECT fa.id, fa.team_member_id, fa.paid_minor, f.currency
            FROM fee_assignments fa JOIN fees f ON f.id = fa.fee_id
            WHERE f.team_id = p_team_id AND f.kind = 'training'
              AND f.period_start = p_period_start AND f.archived_at IS NULL
            ORDER BY fa.id FOR UPDATE OF fa
          )
          UPDATE fee_assignments fa
            SET amount_minor = GREATEST(COALESCE(c.amount_minor, 0), l.paid_minor), updated_at = now()
          FROM locked l
          LEFT JOIN training_period_charges(p_team_id, p_period_start) c
                 ON c.team_member_id = l.team_member_id AND c.currency = l.currency
          WHERE fa.id = l.id
            AND fa.amount_minor IS DISTINCT FROM GREATEST(COALESCE(c.amount_minor, 0), l.paid_minor);

          -- S4: drop assignments that are now zero, unpaid, un-waived and never paid against.
          -- payments.fee_assignment_id is ON DELETE RESTRICT, and a VOIDED payment leaves
          -- paid_minor = 0 while the row survives -- deleting it anyway would 23503. The
          -- stored_status = 'active' guard is a CORRECTION: without it S4 erases a treasurer's
          -- waive and its waived_reason audit text with no trace.
          DELETE FROM fee_assignments fa USING fees f
          WHERE f.id = fa.fee_id AND f.team_id = p_team_id AND f.kind = 'training'
            AND f.period_start = p_period_start AND f.archived_at IS NULL
            AND fa.amount_minor = 0 AND fa.paid_minor = 0
            AND fa.stored_status = 'active'
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.fee_assignment_id = fa.id);
        END;
        $$ LANGUAGE plpgsql
      `,
    ),

    // ---- Trigger (a): the primary trigger, on event_attendance -----------------------------
    // NOT on events: this covers every writer of event_attendance, including the ON DELETE
    // CASCADE from events and from team_members, which an events-only trigger would miss
    // entirely. If the parent event itself was just deleted in the same statement (the cascade
    // from `events`, or from a team delete), its row is already gone by the time this fires --
    // there is nothing left to recompute against, and a later write to that period (there will
    // be one, or the team is gone too) recomputes correctly without this event's contribution.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION event_attendance_training_recompute() RETURNS trigger AS $$
        DECLARE
          v_event_id UUID;
          v_team_id UUID;
          v_start_at TIMESTAMPTZ;
        BEGIN
          v_event_id := COALESCE(NEW.event_id, OLD.event_id);
          SELECT e.team_id, e.start_at INTO v_team_id, v_start_at
          FROM events e WHERE e.id = v_event_id;
          IF v_team_id IS NULL THEN
            RETURN COALESCE(NEW, OLD);
          END IF;
          PERFORM recompute_training_period_fees(v_team_id, training_period_start(v_start_at, v_team_id));
          RETURN COALESCE(NEW, OLD);
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER event_attendance_training_recompute_trg
          AFTER INSERT OR UPDATE OR DELETE ON event_attendance
          FOR EACH ROW EXECUTE FUNCTION event_attendance_training_recompute()
      `,
    ),

    // ---- Trigger (b): a training event's own status/time/type/team change -----------------
    // Widening the WHEN clause beyond NEW.event_type = 'training' is a CORRECTION: a training
    // changed to a match, or moved to another team, otherwise keeps its charges billed forever.
    // pg_trigger_depth() is NOT needed here (unlike events_sync_event_type_trg): these fire
    // AFTER INSERT/UPDATE/DELETE, the recompute only writes fees/fee_assignments (never
    // events), and events_sync_event_type_trg is BEFORE, so NEW.event_type is already resolved
    // by the time this trigger's function body runs.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION events_training_recompute() RETURNS trigger AS $$
        DECLARE
          v_has_attendance BOOLEAN;
          v_old_period DATE;
          v_new_period DATE;
        BEGIN
          IF NEW.status IS NOT DISTINCT FROM OLD.status
             AND NEW.start_at IS NOT DISTINCT FROM OLD.start_at
             AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
             AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
            RETURN NEW;
          END IF;

          -- This EXISTS check MUST precede any lock, so an ordinary reschedule of a training
          -- with no confirmed attendance yet stays lock-free.
          SELECT EXISTS(
            SELECT 1 FROM event_attendance ea
            WHERE ea.event_id = NEW.id AND ea.confirmed_at IS NOT NULL AND ea.present
          ) INTO v_has_attendance;
          IF NOT v_has_attendance THEN
            RETURN NEW;
          END IF;

          v_old_period := training_period_start(OLD.start_at, OLD.team_id);
          v_new_period := training_period_start(NEW.start_at, NEW.team_id);

          -- Earlier period first, deduped, so two concurrent reschedules cannot cycle.
          IF v_old_period <= v_new_period THEN
            PERFORM recompute_training_period_fees(OLD.team_id, v_old_period);
            IF v_new_period <> v_old_period OR NEW.team_id <> OLD.team_id THEN
              PERFORM recompute_training_period_fees(NEW.team_id, v_new_period);
            END IF;
          ELSE
            PERFORM recompute_training_period_fees(NEW.team_id, v_new_period);
            PERFORM recompute_training_period_fees(OLD.team_id, v_old_period);
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER events_training_recompute_trg
          AFTER UPDATE ON events
          FOR EACH ROW WHEN (NEW.event_type = 'training' OR OLD.event_type = 'training')
          EXECUTE FUNCTION events_training_recompute()
      `,
    ),
  ),
);
