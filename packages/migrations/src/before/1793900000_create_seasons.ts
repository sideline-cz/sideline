import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Seasons: a team-wide, dated container for the two things that were previously loose, mutable,
 * single-slot values -- `teams.membership_selection_deadline` (no history: setting next season's
 * deadline destroyed this one's) and `membership_plans.expires_at` (written, read back, displayed,
 * enforced nowhere).
 *
 * A season GROUPS monthly billing periods; it does NOT replace them. `training_period_start`,
 * `fees.period_start`, `idx_fees_team_period_currency` and `recompute_training_period_fees` are
 * untouched in every respect. A season supplies exactly three things: the selection deadline, the
 * expiry that closes selection, and the free-trainings anchor.
 *
 * THE FREE-TRAININGS ALLOWANCE NOW RESETS PER SEASON. That reverses half of #746
 * (1793500000_free_trainings_all_time_allowance.ts), and it is a PRODUCT DECISION, not a
 * regression -- #746 was correct against the requirement it was given ("an allowance a member
 * consumes once, never reset while the membership is active"). The requirement changed: an
 * allowance is now a per-season budget.
 *
 * #746's ANTI-FARMING reasoning SURVIVES this change intact, and that is why the reversal is safe.
 * #746 rejected a PER-MEMBER anchor because `selectMembershipPlan` is member self-service, so a
 * member could re-anchor themselves by toggling plans. A SEASON anchor is manager-controlled and
 * team-wide: no member action moves it, and moving it resets everybody at once and visibly. Only
 * the "never resets" half is reversed; the "not farmable by a member" half is preserved.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- Step 1: the table -----------------------------------------------------------------
    // Constraints are inline in CREATE TABLE IF NOT EXISTS, so they need no DO $$ guard --
    // ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS form, inline inherits the table's.
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS seasons (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id            UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          -- All three are INSTANTS, never DATE buckets. fees.period_start is a DATE only because
          -- it is a team-local month KEY; these are compared against now().
          starts_at          TIMESTAMPTZ NOT NULL,
          -- NULL = selection stays open (the same meaning the teams column had).
          selection_deadline TIMESTAMPTZ,
          -- NULL = the season never ends on its own.
          expires_at         TIMESTAMPTZ,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- This is the tie-break for "the season in effect" (greatest starts_at) AND the index
          -- that serves it: the lookup is WHERE team_id = ? AND starts_at <= now() ORDER BY
          -- starts_at DESC LIMIT 1, which this covers exactly. No additional index -- add one
          -- next to the query that needs it (precedent: 1793100000_create_event_attendance.ts).
          UNIQUE (team_id, starts_at),
          CHECK (expires_at IS NULL OR expires_at > starts_at)
        )
      `,
    ),
    // Deliberate omissions, so nobody "completes" the table later:
    //   * No created_by_user_id / team_member_id. A person FK makes a GDPR EXPORT_MANIFEST entry
    //     MANDATORY (exportManifest.test.ts matches ccu.table_name IN ('users','team_members'))
    //     and nobody asked for the audit column. With team_id only, seasons can never appear in
    //     that test's actual set.
    //   * No archived_at. Nothing deletes a season; history is the point.
    //   * No updated_at trigger -- there is none anywhere in src/before/. The DEFAULT covers
    //     INSERT; the repository sets updated_at = now() on UPDATE.
    //   * No CHECK tying selection_deadline to starts_at. A deadline BEFORE the season starts is
    //     the normal case (pick your plan in August for the September season), and a deadline
    //     AFTER it is also real ("season starts 1 Sep, pick by 15 Sep"). Both stay legal.
    //   * No CHECK tying selection_deadline to expires_at -- the gate tests them independently.

    // ---- Step 2a: seed trigger for future teams ---------------------------------------------
    // This is what makes "a team always has at least one season" a real INVARIANT rather than a
    // backfill snapshot, and it is why no query below carries a zero-seasons branch. Same shape
    // as seed_default_membership_plan_trg (1792800000).
    //
    // THE TRIGGER COMES BEFORE THE BACKFILL, and the order is the whole guarantee -- not a style
    // choice. It is INVERTED from 1792400000 / 1792800000, which seed-then-trigger; both carry
    // the hole described here, inertly, because they are long since applied.
    //
    // MigrateBefore runs inside server boot (applications/server/src/run.ts), so during a rolling
    // deploy an OLD pod is still serving POST /teams while this migration runs. Backfill-first
    // leaves a window: a team created after the backfill statement and before CREATE TRIGGER
    // commits is matched by NEITHER, so it gets no season at all, permanently and invisibly --
    // findSeasons returns None/None (no season panel, so the manager cannot fix it from any
    // surface), selection_is_open falls through to COALESCE(..., true) and never closes, and
    // training_period_charges' season CTE is empty so every member gets a full free-trainings
    // allowance EVERY month.
    //
    // Trigger-first closes it in both directions, VERIFIED on postgres:17 rather than assumed:
    //   * CREATE OR REPLACE TRIGGER ... ON teams takes ShareRowExclusiveLock on teams (checked in
    //     pg_locks, on both the create and the replace path). INSERT INTO teams takes
    //     RowExclusiveLock. The two conflict.
    //   * In-flight inserts DRAIN: the CREATE TRIGGER waits for them to commit, and the backfill
    //     below is a LATER statement in the same READ COMMITTED transaction, so its fresh
    //     snapshot sees those teams and seeds them.
    //   * New inserts BLOCK until this migration commits, by which time the trigger exists and
    //     seeds them itself.
    // The migration runs in ONE transaction (effect's Migrator wraps the whole run in
    // sql.withTransaction), so the lock is held from here to commit.
    //
    // The reorder is free: the backfill's WHERE NOT EXISTS is a FACT guard, so a team the trigger
    // already seeded is simply skipped -- re-running the whole migration stays a true no-op.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION seed_first_season() RETURNS trigger AS $$
        BEGIN
          INSERT INTO seasons (team_id, starts_at) VALUES (NEW.id, now());
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER seed_first_season_trg
          AFTER INSERT ON teams
          FOR EACH ROW EXECUTE FUNCTION seed_first_season()
      `,
    ),

    // ---- Step 2b: backfill one season for EVERY team, carrying BOTH dates ------------------
    // Idempotent via WHERE NOT EXISTS -- a guard on the FACT that no season exists, never on a
    // value predicate (migrations AGENTS.md, "Reinterpreting Stored Values"). Precedent:
    // 1792800000_create_membership_plans.ts's seed.
    //
    // WHY expires_at IS CARRIED AND NOT DROPPED. Measured in production read-only on 2026-10-07:
    // team e2686d09 "Poletíme!" has three active plans, ALL THREE carrying the same
    // expires_at = 2027-02-01 12:00:00+00. One expiry shared by every active plan in a team is
    // not per-plan expiry; it is a season expiry the product had no word for. Setting
    // seasons.expires_at = NULL here would DELETE a date a human deliberately entered, with no
    // replacement. DO NOT "simplify" the correlated subquery out of this statement.
    //
    // The four cases, all handled by the one MAX with no CASE:
    //   1. Zero non-archived plans with a live expiry -> MAX over zero rows is NULL -> NULL.
    //      (Two of the three production teams.)
    //   2. Exactly one distinct non-NULL value -> MAX is that value. The only case in production.
    //   3. More than one distinct value -> MAX, i.e. the LATEST. MAX, never MIN: expiry CLOSES
    //      selection, so the latest can only ever keep a club open at least as long as any
    //      individual plan's date would have. MIN could lock a team out on day one. This
    //      migration must never close a club's selection earlier than their own data said.
    //   4. Archived plans excluded -- an archived plan's expiry is not a live statement of
    //      intent; the plan is already invisible to selection, so its date must not govern.
    //
    // expires_at > now() IS THE CHECK PRECONDITION, not a nicety. CHECK (expires_at IS NULL OR
    // expires_at > starts_at) plus starts_at = now() means a carried-over PAST plan expiry makes
    // this INSERT raise 23514 and ABORT THE WHOLE MIGRATION -- and MigrateBefore runs inside
    // server boot, so the container never starts, for every team. Both now() calls are
    // transaction-start, so the predicate is exactly the CHECK re-stated. It also subsumes
    // IS NOT NULL (NULL > now() is NULL), so it costs nothing.
    // MEASURED: no production team has a past-dated plan expiry. This predicate guards a shape
    // production does not currently contain -- it is DEFENSIVE and is NOT correcting observed
    // data.
    //
    // The one value it does carry is NOON-UTC, and that is deliberate. Carried verbatim. This
    // value is noon-UTC (the old dateOnlyToUtcNoon web field), not end-of-local-day like
    // everything else in this table. ~11h early on the final day; inert for this team because its
    // deadline already passed, and the first Save from the season panel re-anchors it. Do NOT
    // "fix" this with an unguarded in-place UPDATE.
    //
    // selection_deadline is copied VERBATIM, NULL stays NULL -- not re-anchored, not shifted.
    //
    // starts_at = now() at migration time. Measured 2026-10-07: event_attendance is empty and no
    // kind='training' fee exists, so NO CHARGE HAS EVER BEEN COMPUTED and this anchor cannot
    // affect any invoice. (Note for anyone reaching for #746's wording: "every production row is
    // 0" is NO LONGER TRUE -- one plan carries free_trainings_included = 3 and
    // price_per_training_minor = 10000. It still cannot have produced a charge, because
    // attendance is zero.) The direction of error, stated anyway: the free-trainings prior-scan
    // floor becomes the current month, which resets every member's consumed count once -- that
    // UNDER-charges. The alternative, teams.created_at, widens the window and recreates exactly
    // the failure #746 rejected (a club that trained free and then goes paid has every member's
    // prior already above N, so nobody ever gets the allowance) -- that OVER-charges.
    // Over-charging is the worse direction.
    Effect.tap(
      () => sql`
        INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
        SELECT
          t.id,
          now(),
          t.membership_selection_deadline,
          (
            SELECT MAX(mp.expires_at)
            FROM membership_plans mp
            WHERE mp.team_id = t.id
              AND mp.archived_at IS NULL
              AND mp.expires_at > now()
          )
        FROM teams t
        WHERE NOT EXISTS (SELECT 1 FROM seasons s WHERE s.team_id = t.id)
      `,
    ),

    // ---- Step 4a: which season the member is looking at --------------------------------------
    // Only TWO seasons can ever be relevant: the one running (greatest starts_at <= now()) and
    // the one next up (LEAST starts_at > now()). Everything else is history or beyond the
    // horizon. Two earlier rules were wrong and are dead:
    //   * "the season in effect governs" made the rollover case unreachable -- a future season's
    //     deadline expires before that season ever becomes current, so there is no instant at
    //     which a member can pick for it.
    //   * "ANY season with an open window" let a FINISHED season with a NULL selection_deadline
    //     ("that season never had a deadline") hold selection open forever, for every season the
    //     club will ever create.
    //
    // Prefers an OPEN candidate (current before next); falls back to current so a CLOSED team
    // still reports WHICH date shut it -- the consumer needs that to tell "deadline passed" from
    // "season ended".
    //
    // The two LIMIT 1 subqueries both ride UNIQUE (team_id, starts_at): one scans it backwards
    // from now(), the other forwards. No extra index.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION governing_season_id(p_team_id UUID) RETURNS UUID
        LANGUAGE sql STABLE AS $$
          WITH candidates AS (
            (SELECT s.id, 0 AS rank,
                    (s.selection_deadline IS NULL OR s.selection_deadline > now())
                AND (s.expires_at         IS NULL OR s.expires_at         > now()) AS is_open
               FROM seasons s
              WHERE s.team_id = p_team_id AND s.starts_at <= now()
              ORDER BY s.starts_at DESC LIMIT 1)
            UNION ALL
            -- ASC, not DESC. The EARLIEST future season is "next"; with two seasons queued, the
            -- later one must not reopen selection today nor be the date the member is shown.
            (SELECT s.id, 1 AS rank,
                    (s.selection_deadline IS NULL OR s.selection_deadline > now())
                AND (s.expires_at         IS NULL OR s.expires_at         > now()) AS is_open
               FROM seasons s
              WHERE s.team_id = p_team_id AND s.starts_at > now()
              ORDER BY s.starts_at ASC LIMIT 1)
          )
          -- Booleans sort false < true, so DESC puts an open candidate first; rank breaks the tie
          -- toward "current". Zero rows (a team with no seasons) yields NULL.
          SELECT id FROM candidates ORDER BY is_open DESC, rank ASC LIMIT 1
        $$
      `,
    ),

    // ---- Step 4b: THE GATE -------------------------------------------------------------------
    // TRUE when the governing season's window is open, or when the team has no seasons at all
    // (degenerate; seed_first_season_trg makes it unreachable, and COALESCE is the one-token net).
    //
    // The open(s) predicate is written twice, once in each function. Deliberate: a third DB object
    // for a two-line predicate is worse than two copies sitting four lines apart. If it ever
    // appears a THIRD time, extract it.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION selection_is_open(p_team_id UUID) RETURNS BOOLEAN
        LANGUAGE sql STABLE AS $$
          SELECT COALESCE(
            (SELECT (s.selection_deadline IS NULL OR s.selection_deadline > now())
                AND (s.expires_at         IS NULL OR s.expires_at         > now())
               FROM seasons s WHERE s.id = governing_season_id(p_team_id)),
            true)
        $$
      `,
    ),

    // ---- Step 5: the charge, anchored on the SEASON instead of the plan ---------------------
    // ARITY IS UNCHANGED: (UUID, DATE), RETURNS TABLE shape identical. Do not change the
    // signature for any reason. recompute_training_period_fees is plpgsql, so its three call
    // sites (1793200000) carry NO pg_depend edge: CREATE OR REPLACE with a different argument
    // count would create a SECOND function, leave this body live, and a later DROP FUNCTION would
    // succeed silently -- then fail at runtime with 42883 inside a money-writing trigger. Keeping
    // the input arity means CREATE OR REPLACE truly replaces and that landmine is never armed.
    // (A changed RETURNS TABLE shape would at least fail loudly with 42P13; the input arity is
    // the silent one.) Pinned by membershipPlanFreeTrainings.test.ts's
    // count(*) FROM pg_proc WHERE proname = 'training_period_charges' = 1.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION training_period_charges(p_team_id UUID, p_period_start DATE)
        RETURNS TABLE (team_member_id UUID, currency CHAR(3), amount_minor BIGINT)
        LANGUAGE sql STABLE
        AS $$
          -- The allowance is PER SEASON: a plan includes N free trainings a member consumes once
          -- WITHIN THE SEASON governing the period being charged. No ledger and no per-attendance
          -- state -- "already consumed" is a COUNT of the member's attendance in EARLIER periods
          -- of the SAME season, re-derived from scratch on every call, so the function stays
          -- STABLE and idempotent.
          --
          -- ANCHOR = the governing season's starts_at. NOT membership_plans.created_at, NOT
          -- membership_plans.free_trainings_anchor_at (that column and its stamping trigger are
          -- dropped by this migration), and NOT a per-member assignment timestamp.
          --   * Not created_at: the default plan is seeded at TEAM creation (1792800000) and
          --     every member sits on it, so a club that trained for months and then priced that
          --     plan would have every member's prior already above N -- nobody would ever get the
          --     allowance.
          --   * Not a per-member column: selectMembershipPlan is member SELF-SERVICE, so a
          --     per-member anchor would be FARMABLE by toggling plans. #746's rejection of that
          --     still stands and is not reopened here.
          --   * A SEASON anchor is manager-controlled and TEAM-WIDE, so it is not farmable by a
          --     member: no member action moves it, and moving it resets everybody at once and
          --     visibly. That is the whole reason a per-season reset is safe where a per-member
          --     one was not.
          --
          -- No expires_at check here, and that has not changed: a season's expiry closes
          -- SELECTION; it does not alter a charge. Plan-expiry enforcement remains a separate
          -- concern that must end the WHOLE plan at once, never just the allowance.
          -- price_per_training_minor > 0 is the opt-in gate -- a free default plan yields zero
          -- rows, so a team that never priced training gets zero fees, ever.
          WITH season AS (
            -- The team's season governing THIS period. PERIOD-ALIGNED, not instant-aligned:
            -- #746's partition rule requires "prior" and the in-period count to meet on a period
            -- boundary, or trainings in the anchor's own month fall into NEITHER set and the
            -- member gets a second allowance. Same ordering rule as the season-in-effect lookup
            -- (greatest starts_at not after the reference point; ties impossible by
            -- UNIQUE (team_id, starts_at)) -- but the reference point is the PERIOD, not an
            -- instant, which is why this is inline rather than sharing governing_season_id.
            --
            -- Degradation if a team somehow has zero seasons: both scalars are NULL, so every
            -- >= NULL predicate below is NULL, the prior count is 0 and the member gets the full
            -- allowance. An UNDER-charge, the same direction as this migration's backfill.
            -- Documented, deliberately not branched on.
            SELECT s.starts_at,
                   training_period_start(s.starts_at, p_team_id) AS season_period
            FROM seasons s
            WHERE s.team_id = p_team_id
              AND training_period_start(s.starts_at, p_team_id) <= p_period_start
            ORDER BY s.starts_at DESC
            LIMIT 1
          ),
          in_period AS (
            SELECT
              tm.id AS team_member_id,
              plan.currency,
              plan.price_per_training_minor,
              plan.free_trainings_included,
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
              -- The member's own plan, scoped to THIS team. Nothing prevents a team_members row
              -- from naming another team's plan (1792900000_membership_selection.ts's own
              -- comment) -- without the team_id scope here a member would be charged another
              -- club's price, in another club's currency. The two column lists must stay MATCHED
              -- or the UNION ALL will not even parse.
              SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_included
              FROM membership_plans mp
              WHERE mp.id = tm.membership_plan_id
                AND mp.team_id = tm.team_id
                AND mp.archived_at IS NULL
              UNION ALL
              SELECT mp.currency, mp.price_per_training_minor, mp.free_trainings_included
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
                     plan.free_trainings_included
          )
          SELECT
            p.team_member_id,
            p.currency,
            (p.price_per_training_minor * GREATEST(p.attended - f.free_left, 0))::bigint AS amount_minor
          FROM in_period p
          CROSS JOIN LATERAL (
            -- How much allowance is LEFT when this period starts: the plan's allowance minus
            -- everything the member already burned in EARLIER periods OF THIS SEASON.
            --
            -- PERIOD-ALIGNED, NOT INSTANT-ALIGNED, and this is the whole correctness argument.
            -- in_period above counts a WHOLE period with no anchor filter. If the floor here were
            -- the season's starts_at INSTANT, the two sets would not partition: trainings in the
            -- season's own month that happened before it started would be covered by that month's
            -- pass and then vanish from the next month's prior, handing the member a second full
            -- allowance. Comparing training_period_start on both sides makes the two sets meet
            -- exactly at the period boundary. Consequence, deliberate: the season's own month
            -- counts in full, including trainings from before the season started.
            --
            -- The two start_at bounds are LOOSE sargable floors/ceilings for idx_events_team_date
            -- only; the two period comparisons are the real predicates. 32 days covers the longest
            -- month plus the widest IANA offset. The upper bound is safe for the whole IANA range
            -- (-12..+14): an event whose TEAM-LOCAL period is before p_period_start has a UTC
            -- instant strictly below p_period_start + 1 day (worst case -12 puts local midnight at
            -- +12h UTC).
            --
            -- The CASE is a COST guard, not a semantic one: with a 0 allowance the scan's answer
            -- is provably GREATEST(0 - n, 0) = 0, and a scalar subquery inside CASE is only
            -- evaluated when its branch is taken. Measured on PG17, 30 members x 3 years (534
            -- trainings, 16 020 attendance rows), allowance 0: 142 ms -> 3.5 ms per call, and a
            -- 20-member squad confirm 8.3 s -> ~0.2 s -- all of it inside S1's team-wide fees
            -- mutex. Identical results (same row count, same sum(amount_minor)). No assertion can
            -- observe cost, so this comment is the pin: do NOT flatten the CASE back into a plain
            -- subquery.
            --
            -- The two (SELECT ... FROM season) references are SCALAR CTE references, which fold
            -- into a once-per-execution InitPlan -- the same argument that already justifies
            -- p_team_id-as-parameter below. Do not inline the season lookup into these predicates.
            --
            -- p_team_id, not pe.team_id, in both training_period_start calls: the WHERE above pins
            -- pe.team_id = p_team_id on every row, so they are the same value, but only the
            -- parameter form lets the team_settings probe fold into a once-per-execution InitPlan
            -- instead of a per-row correlated SubPlan.
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
                AND pe.start_at >= (SELECT starts_at FROM season) - INTERVAL '32 days'
                AND pe.start_at <  (p_period_start + INTERVAL '1 day') AT TIME ZONE 'UTC'
                AND training_period_start(pe.start_at, p_team_id) >= (SELECT season_period FROM season)
                AND training_period_start(pe.start_at, p_team_id) < p_period_start
            ) END AS free_left
          ) f
          -- THIS is what stops a negative amount_minor: a member fully covered by their remaining
          -- allowance is not emitted at all. Dropping them rather than emitting a 0 row is also
          -- what stops S0 creating an empty fees shell for a period nobody owes anything in
          -- (shells are never deleted). An EXISTING assignment that falls to zero is still
          -- handled: S3 LEFT JOINs this function, so the missing row zeroes it via COALESCE and
          -- S4 prunes it.
          WHERE p.attended > f.free_left
        $$
      `,
    ),

    // ---- Step 6: drop the plan-level anchor --------------------------------------------------
    // Safe because the column has ZERO application readers: the only one was the old
    // training_period_charges body, replaced in Step 5 above.
    //
    // ORDER MATTERS. Trigger before function: pg_trigger.tgfoid is a hard dependency, so dropping
    // the function first would need CASCADE. Column last, because Step 5 must already have removed
    // the only reader.
    //
    // membership_plans_pricing_recompute_trg's WHEN clause deliberately does NOT watch
    // free_trainings_anchor_at (1793600000), so dropping the column does not change that clause
    // and the trigger is not re-issued.
    Effect.tap(
      () => sql`
        DROP TRIGGER IF EXISTS membership_plans_stamp_free_trainings_anchor_trg ON membership_plans
      `,
    ),
    Effect.tap(() => sql`DROP FUNCTION IF EXISTS membership_plans_stamp_free_trainings_anchor()`),
    Effect.tap(
      () => sql`ALTER TABLE membership_plans DROP COLUMN IF EXISTS free_trainings_anchor_at`,
    ),

    // ---- Step 7: recompute when a season lands inside the OPEN period -----------------------
    // Precedent: 1793600000_recompute_fees_on_plan_change.ts.
    //
    // ROLLOVER BY THE CLOCK NEEDS NO TRIGGER, and that is provable rather than hopeful. A season
    // becomes current by the passage of time, which is not a write, so nothing can fire here. It
    // does not matter: training_period_charges(team, P) resolves the season governing PERIOD P by
    // period alignment at whatever time it is called, so October's charges use season 2 whether
    // they are computed in August or in October. There is no clock-driven staleness to close.
    // This trigger exists for exactly ONE case: a season inserted MID-PERIOD, which changes the
    // OPEN month's anchor immediately.
    //
    // ACCEPTED CONSEQUENCE, with copy as the mitigation: that mid-period insert RESETS THE WHOLE
    // MONTH's free trainings and can DROP an invoice a member has already seen.
    // training_period_start is a team-local calendar MONTH, so a season starting 2026-09-15 has
    // season_period = 2026-09-01. Allowance 2, member attended Sep 5 and Sep 10 with the allowance
    // burned, September fee 2 x price; queue a season starting Sep 15 and this trigger fires, the
    // fee drops to 0 and the assignment is pruned. Correct per #746's partition rule and in the
    // UNDER-charge direction. The season hint string says a mid-month start resets that month's
    // free trainings, and the "Season starts" input defaults to the 1st. Re-anchoring the period
    // floor to training_period_start(starts_at) + 1 month is a real behaviour change and belongs
    // to the billing ticket.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION seasons_recompute() RETURNS trigger AS $$
        DECLARE v_period DATE;
        BEGIN
          v_period := training_period_start(now(), NEW.team_id);
          -- PERIOD-aligned, not instant-aligned, and this is the whole correctness argument.
          -- training_period_charges resolves a season by PERIOD
          -- (training_period_start(s.starts_at) <= p_period_start), so a season starting Sep 15
          -- governs ALL of September the moment it is inserted -- even though its starts_at is
          -- still in the future. An "IF NEW.starts_at > now() THEN RETURN NULL" guard suppresses
          -- the recompute for exactly that case, which is the only case this trigger exists for.
          -- Compare PERIODS, never instants.
          --
          -- ON UPDATE, OLD COUNTS TOO, and skipping it is the money bug this arm exists to close.
          -- Moving a queued start OUT of the open period (Sep 20 -> Nov 1) leaves the open period
          -- governed by a DIFFERENT season than it was a moment ago -- NEW's period is in the
          -- future, so NEW alone would RETURN NULL here and September would keep a charge computed
          -- against a season that no longer governs it. OLD's period is the open one, so the OR
          -- below fires. The move INTO the open period (Nov 1 -> Sep 20) is the mirror, caught by
          -- NEW. team_id is never updated (the trigger is UPDATE OF starts_at and no writer
          -- touches team_id), so NEW.team_id serves both rows.
          IF training_period_start(NEW.starts_at, NEW.team_id) > v_period
             AND (TG_OP <> 'UPDATE'
                  OR training_period_start(OLD.starts_at, NEW.team_id) > v_period) THEN
            RETURN NULL;  -- neither the old nor the new period is the open one; the affected
                          -- periods are all in the future and are recomputed by whatever write
                          -- first touches them, with this season already resolvable.
          END IF;
          -- Pre-check BEFORE any lock, same shape as events_training_recompute's EXISTS guard. No
          -- training fee shell for the open period = no money on the table = nothing to correct.
          -- This is also what makes the Step 2a seed trigger and the Step 2b backfill no-ops.
          IF NOT EXISTS (
            SELECT 1 FROM fees f
            WHERE f.team_id = NEW.team_id AND f.kind = 'training'
              AND f.period_start = v_period AND f.archived_at IS NULL
          ) THEN RETURN NULL; END IF;
          PERFORM recompute_training_period_fees(NEW.team_id, v_period);
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    // INSERT **OR UPDATE OF starts_at**. INSERT-only was wrong: updateNextSeasonQuery
    // (MembershipPlansRepository) rewrites starts_at on every Save after the first, so a queued
    // season moved across a period boundary changed what training_period_charges computes for the
    // open month while firing nothing -- the stored invoice stayed wrong until an unrelated write
    // jolted it. The old reason for INSERT-only ("a running season's start is history") does not
    // apply: starts_at is writable only on the FUTURE slot, and the function's own PERIOD guard
    // returns early for anything outside the open period, so a settled month can never be
    // re-priced from a date box.
    //
    // OF starts_at, not a bare UPDATE: a deadline/expiry Save moves no money, and the column list
    // keeps it lock-free.
    //
    // ONE PERIOD, SO NO ORDERING TO GET WRONG. The function recomputes exactly
    // training_period_start(now()) and nothing else, on every path -- so there is no multi-period
    // pass here and no 40P01 window of the kind 1793500000's period-ASCENDING loop exists to
    // close. That is deliberate, not an omission: moving a start from Sep to Nov changes the
    // governing season for Sep, Oct AND Nov (every period in between), which is an unbounded
    // range no trigger should walk. Past periods are frozen by recompute_training_period_fees'
    // own early return; future periods are recomputed by whatever write first touches them, with
    // this season already resolvable -- exactly the INSERT path's contract. Only the OPEN period
    // is corrected here, and only the open period can go stale without being noticed.
    //
    // LOCK ORDER: this adds a new leg, seasons -> fees. Nothing takes them in the opposite order
    // today. A future path that locks fees and then writes seasons is a 40P01 on a money write.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER seasons_recompute_trg
          AFTER INSERT OR UPDATE OF starts_at ON seasons
          FOR EACH ROW EXECUTE FUNCTION seasons_recompute()
      `,
    ),
  ),
);
