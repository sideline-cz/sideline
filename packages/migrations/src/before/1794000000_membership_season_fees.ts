import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * `membership_plans.price_minor` -- the plan's OWN price, e.g. 1500 Kc for "Kazdy trenink" -- has
 * been shown to members since #728 and billed to nobody, ever. Every reference to it was CRUD
 * plumbing. This migration is the writer.
 *
 * ONCE PER SEASON, AND THE SEASON IS THE KEY. #753 (1793900000_create_seasons.ts) shipped
 * `seasons` and `governing_season_id` and deliberately stopped short of making that key reachable
 * from a fee row. This closes that gap: `fees.season_id` plus
 * `idx_fees_team_season_plan_currency` make "charged once" enforceable IN THE DATABASE, not in a
 * candidate query. A `(team, period_start)` anchor was rejected -- `period_start` is a calendar
 * MONTH and is already spoken for by `fees_kind_period_start_check`; a snapshot of
 * `selection_deadline` was rejected because a mutable date is not an identity.
 *
 * THE CHARGE IS A DELTA, NOT A RESTATEMENT, and that is what makes reassignment work in both
 * directions without ever rewriting a row:
 *   * net = SUM(the member's membership assignments this season) - SUM(their membership refunds
 *     this season). target = their CURRENT plan's price.
 *   * target > net -> write the GAP as a new assignment, under the shell for the plan they are on
 *     now. An upgrade 900 -> 1500 is therefore a SECOND fee for 600; the original 900 is untouched.
 *   * target < net -> issue the difference as member CREDIT. A downgrade 1500 -> 900 leaves the
 *     1500 standing and hands back 600, which AutoApplyCreditCron (#751) then spends against their
 *     next charge on its own. That interaction is intended, not incidental.
 *   * target = net -> write NOTHING. This is the steady state, and it is what makes a second tick
 *     over the same state a no-op: idempotence by DERIVATION, the same way
 *     recompute_training_period_fees gets it, rather than by a marker column.
 *
 * A PLAN AT price_minor = 0 PRODUCES NO FEE AT ALL, not a zero-amount one. The `delta > 0` filter
 * at the write sites is the whole gate -- there is no shell, no assignment and no row of any kind
 * for a member who owes nothing. Same reasoning as `training_period_charges`' own
 * `price_per_training_minor > 0` opt-in gate and S0's refusal to create an empty shell: shells are
 * never deleted.
 *
 * NOT A TRIGGER. A cron (`MembershipBillingCron`) drives this, for the reasons
 * AutoApplyCreditCron's header gives: a trigger on `team_members` fires with `team_members`
 * already locked and would have to take `seasons`, `fees` AND `member_credit_accounts` from inside
 * one, and a trigger also cannot catch a member who joins mid-season without any write happening
 * at all. `team_members_plan_recompute_trg` (1793600000) stays exactly as it is -- it recomputes
 * TRAINING fees and must not learn to move credit.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- Step 1: the season key on the fee row ----------------------------------------------
    // ON DELETE RESTRICT, not SET NULL: `fees_kind_season_check` below pairs the column to the
    // kind, so a SET NULL would raise 23514 on the delete instead of quietly orphaning the row --
    // but RESTRICT says the intent out loud and fails at the right place. It guards nothing in
    // practice (1793900000 Step 1: "No archived_at. Nothing deletes a season; history is the
    // point"), and it does NOT block deleting a team: non-deferrable FK triggers fire at END of
    // statement, by which time the fees.team_id -> teams cascade has already removed the
    // referencing row. That is MEASURED, not reasoned -- 1792900000's own comment records the same
    // experiment for team_members.membership_plan_id.
    Effect.tap(
      () => sql`
        ALTER TABLE fees
          ADD COLUMN IF NOT EXISTS season_id UUID REFERENCES seasons(id) ON DELETE RESTRICT
      `,
    ),
    // WHY THE PLAN IS PART OF THE FEE'S IDENTITY AND NOT JUST A LABEL. An upgrade must write a
    // SECOND fee for the gap and must not rewrite the first. With ONE shell per (team, season,
    // currency) that is structurally impossible: `fee_assignments UNIQUE (fee_id, team_member_id)`
    // gives the member exactly one row under it. The plan the member moved ONTO is the only thing
    // that distinguishes the gap charge from the original, so it has to be in the shell key.
    //
    // The alternative -- a fresh unkeyed shell per charge event -- was rejected: it yields one
    // `fees` row per member per season, which is the "hid charges from the fees page" shape
    // 1793200000's header rejected for per-training charging, and it has no unique key at all, so
    // two concurrent ticks would lose on nothing.
    Effect.tap(
      () => sql`
        ALTER TABLE fees
          ADD COLUMN IF NOT EXISTS membership_plan_id UUID
            REFERENCES membership_plans(id) ON DELETE RESTRICT
      `,
    ),

    // ---- Step 2: widen the kind CHECK -------------------------------------------------------
    // 'membership', not 'season' (a training fee is season-anchored too since #753, so the word
    // names the key rather than the charge) and not 'plan'.
    //
    // NO SANITISING UPDATE IS NEEDED and none is written: this is a pure widening, so every
    // existing row already satisfies the new expression. (migrations AGENTS.md requires the
    // repair-first order only when the expression can reject or RAISE on an existing row.)
    //
    // The constraint name is POSTGRES-GENERATED -- 1793200000:23 added it inline on
    // `ADD COLUMN ... CHECK`, so there is no name in the source to copy. Anchored lookup on the
    // definition's prefix with an at-most-one assertion, lifted verbatim from
    // 1792800001_auto_credit_bank_transfers.ts: a bare ILIKE '%kind%' would silently drop the
    // wrong constraint if a second CHECK on `fees` ever mentions the word.
    Effect.tap(
      () => sql`
        DO $$
        DECLARE c TEXT; n INT;
        BEGIN
          SELECT count(*), min(conname) INTO n, c FROM pg_constraint
           WHERE conrelid = 'fees'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE 'CHECK ((kind %';
          IF n > 1 THEN
            RAISE EXCEPTION 'expected at most one kind CHECK on fees, found %', n;
          END IF;
          IF n = 1 THEN EXECUTE format('ALTER TABLE fees DROP CONSTRAINT %I', c); END IF;
          -- conrelid-scoped, not conname alone: pg_constraint is unique on
          -- (conrelid, contypid, conname), so a same-named constraint on ANOTHER table would make
          -- an unscoped guard skip the ADD and leave fees unprotected. Same for both guards below.
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conrelid = 'fees'::regclass AND conname = 'fees_kind_values') THEN
            ALTER TABLE fees ADD CONSTRAINT fees_kind_values
              CHECK (kind IN ('manual','training','membership'));
          END IF;
        END $$
      `,
    ),

    // ---- Step 3: pair both new columns to the new kind --------------------------------------
    // `fees_kind_period_start_check` from 1793200000 -- CHECK ((kind = 'training') = (period_start
    // IS NOT NULL)) -- is DELIBERATELY LEFT ALONE and is already correct for the new kind: for a
    // 'membership' row both sides are FALSE, so period_start must stay NULL, which is exactly
    // right. A membership charge is not anchored on a calendar month and must never acquire a
    // period, or `idx_fees_team_period_currency` and recompute_training_period_fees would both
    // start seeing it. Do not "complete" that constraint into a three-way CASE.
    //
    // Two constraints rather than one combined expression: a single
    // CHECK ((kind = 'membership') = (season_id IS NOT NULL AND membership_plan_id IS NOT NULL))
    // would accept a 'manual' row carrying exactly one of the two.
    //
    // ADD CONSTRAINT has no IF NOT EXISTS form and these are BRAND NEW (not replacements), so each
    // needs the pg_constraint guard -- migrations AGENTS.md, "Widening a UNIQUE Constraint" rule 5.
    Effect.tap(
      () => sql`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conrelid = 'fees'::regclass
                            AND conname = 'fees_kind_season_check') THEN
            ALTER TABLE fees ADD CONSTRAINT fees_kind_season_check
              CHECK ((kind = 'membership') = (season_id IS NOT NULL));
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conrelid = 'fees'::regclass
                            AND conname = 'fees_kind_plan_check') THEN
            ALTER TABLE fees ADD CONSTRAINT fees_kind_plan_check
              CHECK ((kind = 'membership') = (membership_plan_id IS NOT NULL));
          END IF;
        END $$
      `,
    ),

    // ---- Step 4: THE constraint that makes "once per (member, season)" a database fact -------
    // One LIVE shell per (team, season, plan, currency). Composed with the PRE-EXISTING
    // `fee_assignments UNIQUE (fee_id, team_member_id)` (1783000000), that is exactly one LIVE
    // charge per (member, season, plan) -- and since a member is on one plan at a time, exactly
    // one ORIGINAL charge per (member, season), with later moves adding their own keyed rows.
    //
    // A second concurrent tick therefore loses on a CONSTRAINT, not on a race-y SELECT: both
    // sessions reach the shell INSERT, one gets 23505 and its ON CONFLICT DO NOTHING absorbs it;
    // both reach the assignment INSERT, the unique constraint serialises them.
    //
    // `archived_at IS NULL` IS LOAD-BEARING. DO NOT "SIMPLIFY" IT BACK OUT -- it is the
    // difference between billing a late joiner and never billing them, measured on a real
    // postgres:17:
    //   1. member 1 is billed 1500 under the shell `Standard 2026-09-07`.
    //   2. the treasurer archives that shell -- `archiveFee`, a supported action, and the exact
    //      mitigation §Risk 1 prescribes for a mid-season currency change.
    //   3. member 2 joins on the SAME Standard plan. `membership_season_charges` correctly
    //      reports delta_minor = 1500 for them.
    //   4. WITHOUT the predicate: S1's ON CONFLICT DO NOTHING infers the unfiltered index, the
    //      ARCHIVED shell is the conflict, and no live shell is ever created -- while S4's join
    //      requires `archived_at IS NULL`, so no assignment is written either. Member 2 is
    //      never billed. There is no un-archive endpoint, so it is PERMANENT, and it is silent:
    //      no error, no log line, no UI surface. It is also non-convergent -- delta stays 1500
    //      forever, so the pre-check in recompute_membership_season_fees passes on every tick
    //      and takes the `seasons` row lock and the team-wide `fees` mutex 1440 times a day to
    //      write nothing at all.
    //   WITH it: S1 creates a FRESH live shell, member 2 is billed exactly once, member 1's
    //   archived 1500 is untouched, zero credit is minted, and delta returns to 0.
    //
    // The replacement shell does NOT re-bill the members who were under the archived one:
    // `charged.sum_minor` (Step 8) counts archived assignments, so their delta stays 0. That
    // sum, not this index, is what makes "archiving cancels the charge" true -- see S4.
    //
    // So the index alone no longer proves "one charge per (member, season, plan)" -- an archived
    // shell and its live replacement can coexist under the same key. The derivation proves it
    // instead, and that is the honest statement of where the guarantee lives.
    //
    // THE ON CONFLICT CLAUSE IN S1 RESTATES THIS PREDICATE CHARACTER-FOR-CHARACTER, and must
    // keep doing so: a partial unique index is only inferable when its predicate is restated
    // (42P10 otherwise), the same trap idx_fees_team_period_currency documents. Edit one side
    // only and you get 42P10 on every tick -- or, if some other index happens to match the
    // column list, a silent conflict resolved against the wrong key. Change both or neither.
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fees_team_season_plan_currency
          ON fees (team_id, season_id, membership_plan_id, currency)
          WHERE kind = 'membership' AND archived_at IS NULL
      `,
    ),

    // ---- Step 5: the season key on the refund ------------------------------------------------
    // A downgrade hands money back as member credit, and the next tick has to know how much it
    // already handed back or it will hand it back again every minute forever. There is nothing
    // else on the row that distinguishes a membership refund from a treasurer's deposit or a
    // bank-transfer remainder.
    //
    // Nullable: every deposit written before this migration, and every future treasurer deposit,
    // carries NULL. No paired CHECK against `source` -- an 'auto' deposit can legitimately be a
    // bank remainder (season_id NULL) or a plan downgrade (season_id set), and those two are
    // distinguished by `bank_transaction_id`, not by a third flag.
    Effect.tap(
      () => sql`
        ALTER TABLE member_credit_deposits
          ADD COLUMN IF NOT EXISTS season_id UUID REFERENCES seasons(id) ON DELETE RESTRICT
      `,
    ),

    // ---- Step 6: an 'auto' deposit no longer implies a bank transaction ----------------------
    // 1792800001 wrote the pair as
    //   (source = 'manual' AND bank_transaction_id IS NULL) OR (source = 'auto' AND ... NOT NULL)
    // because at the time the only system-written deposit WAS a bank remainder. It is not anymore:
    // this feature's downgrade refund is system-written with no transaction behind it.
    //
    // The REAL invariant -- the one `/unmatch` depends on -- is only the reverse direction: a row
    // carrying a bank_transaction_id must be 'auto', so that unmatching a transfer can find and
    // undo every deposit it created. That direction is preserved byte-for-byte below; what is
    // dropped is the converse, which was never load-bearing. A 'manual' row with a transaction is
    // still rejected.
    //
    // WHY NOT A NEW `source` LITERAL. `MemberCreditSource` is ON THE WIRE
    // (packages/domain/src/models/MemberCredit.ts:9, read by FinanceApi's MemberCreditDepositView),
    // so adding one would trigger domain AGENTS.md's wire-value projection rule and buy a two-
    // release lifecycle for a label. 'auto' is also simply true here: nobody recorded it, and
    // listDepositsByMember already maps source = 'auto' to a NULL recorder name precisely so a
    // treasurer is never credited with a deposit they did not make.
    // Two plain statements, no DO $$ wrapper: this is a REPLACEMENT of a constraint whose name we
    // know, so `DROP ... IF EXISTS` + `ADD` is already idempotent on its own and is the precedent
    // 1793200000:30-38 uses. The DO $$ guard is only needed for a BRAND-NEW constraint (Step 3).
    Effect.tap(
      () => sql`
        ALTER TABLE member_credit_deposits
          DROP CONSTRAINT IF EXISTS member_credit_deposits_bank_source_pair
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE member_credit_deposits ADD CONSTRAINT member_credit_deposits_bank_source_pair
          CHECK (bank_transaction_id IS NULL OR source = 'auto')
      `,
    ),

    // ---- Step 7: the opt-in, which is also the recorder --------------------------------------
    // Same shape and same two jobs as team_settings.auto_apply_credit_by_user_id (1793800000):
    // NULL is off, non-NULL is on AND names the user every member_credit_deposits row this
    // feature writes is attributed to. It needs to name a user because recorded_by_user_id is
    // NOT NULL and a cron has no authenticated caller of its own.
    //
    // A SEPARATE COLUMN, not a reuse of auto_apply_credit_by_user_id. Reusing it would couple two
    // features the product decisions did not couple: a club that wants membership billing but not
    // automatic credit application could not express it, and -- worse -- a club that never opted
    // into auto-apply would have no recorder available for a DOWNGRADE REFUND, so reassignment
    // would silently fail for them.
    //
    // DEFAULT OFF IS NOT COSMETIC. 25 production members sit on 5 active plans today, one of them
    // priced. An unconditional cron bills real money to real people the minute the pod boots, with
    // nobody having asked for it.
    //
    // ON DELETE SET NULL, not RESTRICT: a departing admin must not pin a team's settings row. The
    // consequence is deliberate and is the reason the two jobs share one column -- deleting that
    // user turns billing OFF rather than leaving it on with nobody to attribute the money to.
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS membership_billing_by_user_id UUID
            REFERENCES users(id) ON DELETE SET NULL
      `,
    ),

    // ---- Step 8: what each member owes (or is owed) for one (team, season) -------------------
    // STABLE and derived from scratch on every call -- no ledger, no marker column, no per-member
    // state. "Already charged" is a SUM over the fee assignments that exist, re-read each time.
    // That is the whole idempotence argument: running this twice yields delta = 0 the second time.
    //
    // THE SIGN IS THE ROUTING. delta > 0 is a charge (first charge or an upgrade gap), delta < 0 is
    // a refund (a downgrade), delta = 0 writes nothing. There is deliberately NO `price_minor > 0`
    // gate here, unlike training_period_charges: a member who moves ONTO a free plan must still
    // produce a NEGATIVE delta so their earlier charge is handed back. The zero-fee rule is
    // enforced at the WRITE sites by `delta > 0`, which is strictly stronger -- a member with
    // nothing to pay produces no shell and no assignment, not a zero-amount one.
    //
    // EVERY ACTIVE MEMBER IS RETURNED, ALWAYS. There is no branch that drops a member from the
    // result set -- the only thing a human correction changes is the SIGN they are allowed to
    // have. A cancellation -- an archived fee, a waived assignment, a voided refund -- does not
    // branch the arithmetic; it lowers a NUMERIC FLOOR under how far the delta may go negative.
    // The rule in one line: REFUND DOWN TO THE MEMBER'S CURRENT PLAN PRICE AND NO FURTHER, where
    // "down to" is measured against money that is still collectable. With nothing cancelled the
    // floor collapses and the expression is plain `raw`. Two earlier drafts got this wrong in
    // opposite directions -- dropping settled members (a cohort-wide, irreversible kill switch)
    // and zero-clamping them (a high-water ratchet that billed 2100 on a 900 plan) -- and both
    // walks are kept in the `gross` lateral so neither is reinvented.
    //
    // NEW ARGUMENT, NEW NAME, NO OVERLOAD RISK. This is a brand-new function, so the 42883 landmine
    // 1793900000 describes for training_period_charges does not apply -- but the rule does: once
    // this ships, DO NOT change its arity. CREATE OR REPLACE with a different argument count
    // creates a SECOND function and leaves this body live.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION membership_season_charges(p_team_id UUID, p_season_id UUID)
        RETURNS TABLE (team_member_id UUID, membership_plan_id UUID, currency CHAR(3), delta_minor BIGINT)
        LANGUAGE sql STABLE
        AS $$
          SELECT
            tm.id,
            plan.id,
            plan.currency,
            -- THE REFUND FLOOR. No CASE and no branch: when nothing has been cancelled the
            -- floor is exactly -raw and this collapses to plain raw (proved in the gross
            -- lateral). It only ever SHRINKS A REFUND; it can never touch a charge.
            GREATEST(gross.raw_minor, -gross.floor_minor)
          FROM team_members tm
          CROSS JOIN LATERAL (
            -- The member's own plan, scoped to THIS team, with the team default as the fallback.
            -- Lifted structurally from training_period_charges and for the same reason: nothing
            -- prevents a team_members row from naming ANOTHER team's plan
            -- (1792900000_membership_selection.ts's own comment), and without mp.team_id =
            -- tm.team_id a member would be billed another club's price in another club's
            -- CURRENCY. The two column lists must stay MATCHED or the UNION ALL will not parse.
            --
            -- The fallback is also DECISION 4: a member who never selected is billed the team
            -- default plan's price. Not choosing is still a membership.
            --
            -- Both branches require archived_at IS NULL, and the NOT EXISTS re-states the scope --
            -- so a member pointing at an ARCHIVED plan, or at a foreign team's plan, falls through
            -- to the default rather than escaping billing.
            SELECT mp.id, mp.currency, mp.price_minor
            FROM membership_plans mp
            WHERE mp.id = tm.membership_plan_id
              AND mp.team_id = tm.team_id
              AND mp.archived_at IS NULL
            UNION ALL
            SELECT mp.id, mp.currency, mp.price_minor
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
          LEFT JOIN LATERAL (
            -- TWO sums over the same rows, and the difference between them is the whole
            -- human-correction story.
            --
            --   sum_minor        -- everything the member has been BILLED this season, archived
            --                       and waived rows INCLUDED. This is the ledger of what the
            --                       generator has already written, and raw is computed against
            --                       it so that an upgrade after a cancellation bills the GAP
            --                       rather than re-billing the whole price.
            --   collectable_minor -- what the member can still actually be MADE TO PAY: archived
            --                       fees and waived assignments excluded. This is the only input
            --                       to the refund floor, because you cannot hand back money
            --                       against a charge the club already cancelled.
            --
            -- (An earlier draft had no second sum and instead dropped, then zero-clamped, any
            -- member with a cancelled row. Both shapes were wrong in opposite directions -- see
            -- the gross lateral.)
            --
            -- fa.stored_status is NOT NULL (1783000000:37), so <> 'waived' has no three-valued
            -- trap.
            SELECT SUM(fa.amount_minor) AS sum_minor,
                   SUM(fa.amount_minor) FILTER (
                     WHERE f.archived_at IS NULL AND fa.stored_status <> 'waived'
                   ) AS collectable_minor
            FROM fee_assignments fa
            JOIN fees f ON f.id = fa.fee_id
            WHERE f.team_id = p_team_id
              AND f.kind = 'membership'
              AND f.season_id = p_season_id
              AND f.currency = plan.currency
              AND fa.team_member_id = tm.id
          ) charged ON true
          LEFT JOIN LATERAL (
            -- TWO sums again, split by the void, both scoped to this season AND this currency.
            --
            --   sum_minor    -- credit the member ACTUALLY HOLDS from this feature this season.
            --                   voided_at IS NULL is required, not decorative: voidDeposit
            --                   (MemberCreditsRepository:391) DECREMENTS balance_minor and stamps
            --                   voided_at, so the row survives but the money is gone. raw is
            --                   computed against reality or it is wrong on the next plan move.
            --   voided_minor -- credit that WAS handed back and then taken away by a treasurer.
            --                   The member does not hold it, so it must not reduce what they owe
            --                   -- but it DOES reduce how much more we are allowed to refund,
            --                   because the club already tried that once and reversed it. This is
            --                   the term that stops the next tick re-minting a voided refund
            --                   within 60 seconds, forever.
            --
            -- Both FILTERs sit inside the currency-scoped lateral, so a voided CZK deposit has no
            -- effect on the member's EUR plan. An earlier boolean "settled" flag was NOT
            -- currency-scoped and silently froze the other currency too.
            --
            -- A treasurer's ordinary manual credit deposit carries season_id IS NULL and is
            -- therefore in NEITHER sum -- which is exactly what makes "write a manual deposit" a
            -- safe escape hatch: the correction does not feed back into this arithmetic.
            SELECT SUM(d.amount_minor) FILTER (WHERE d.voided_at IS NULL)     AS sum_minor,
                   SUM(d.amount_minor) FILTER (WHERE d.voided_at IS NOT NULL) AS voided_minor
            FROM member_credit_deposits d
            WHERE d.team_member_id = tm.id
              AND d.currency = plan.currency
              AND d.season_id = p_season_id
          ) refunded ON true
          CROSS JOIN LATERAL (
            -- THE MOVE, AND THE FLOOR UNDER IT. Both named here so the SELECT list does not have
            -- to restate a money expression -- a restated money expression is one that drifts.
            --
            -- raw_minor:   what the member's CURRENT plan costs, minus what they have been
            --              billed, plus credit they hold. Positive = charge the gap, negative =
            --              refund the difference.
            --
            -- floor_minor: the MOST we are still allowed to refund, in one sentence --
            --              "refund down to the point where what the member can still be made to
            --              pay, net of credit they hold and credit the treasurer took back,
            --              equals their plan price, and no further."
            --
            -- IT COLLAPSES TO NOTHING IN THE NORMAL CASE, which is why there is no branch. With
            -- no cancellation anywhere, collectable = charged and voided = 0, so
            --   floor = GREATEST(charged - refunded - price, 0) = GREATEST(-raw, 0)
            -- and GREATEST(raw, -floor) is raw for raw >= 0 and raw for raw < 0. Exactly raw,
            -- both branches, no CASE. Verified by exhaustive sweep, not by inspection.
            --
            -- WHY NOT A BOOLEAN "settled -> GREATEST(raw, 0)" CLAMP, which this replaced: a
            -- boolean freezes the member's collectable charge at its HIGH-WATER MARK and the
            -- error RATCHETS. Walk it -- Basic 900, Standard 1500, Pro 2100, one season:
            --   1. on Standard, tick      -> assign 1500. charged 1500, collectable 1500
            --   2. -> Basic, tick         -> raw -600 -> refund 600
            --   3. treasurer VOIDS it     -> holds 0; owes 1500 on a 900 plan. HIS CALL, fine.
            --   4. -> Pro, tick           -> raw +600 -> gap billed. charged 2100. Correct.
            --   5. -> Basic, tick         -> raw = 900 - 2100 = -1200
            --      boolean clamp -> 0. ON A 900 PLAN, OWES 2100, HOLDS NOTHING. Both assignments
            --      live and unarchived so fee_assignment_status_v.due_minor is the full 2100, the
            --      member's payments page shows 2100, every reminder rung fires, and
            --      updateAssignment 409s GeneratedFeeImmutable so the treasurer cannot fix the
            --      row. The 1200 has nothing to do with the 600 that was voided six months
            --      earlier, and it grows with every further down-move.
            --      THIS FLOOR -> GREATEST(-1200, -600) = -600 -> refund 600 -> net 1500, over by
            --      exactly the 600 the treasurer took back. Bounded and attributable.
            --   It is reachable with NO void at all: waive or archive the 600 upgrade-gap row
            --   while the 1500 stays live and the boolean clamp leaves the member owing 1500 on a
            --   900 plan.
            --
            -- THE INVARIANT, stated so it can be checked rather than hoped for:
            --     collectable - refunded  <=  price + voided
            -- holds after every tick. With no treasurer void -- every waive path, every archive
            -- path, and the entire normal case -- voided is 0 and it reads: A MEMBER IS NEVER
            -- LEFT OWING MORE THAN THEIR CURRENT PLAN'S SEASON PRICE. The single exception is a
            -- deliberate human reversal, bounded by exactly the amount reversed. Checked
            -- exhaustively over the whole grid, together with: the no-settlement collapse above,
            -- idempotence (a second tick over the post-tick state yields 0), and that the floor
            -- only ever shrinks a REFUND and never alters a charge.
            SELECT (plan.price_minor
                      - COALESCE(charged.sum_minor, 0)
                      + COALESCE(refunded.sum_minor, 0))::bigint AS raw_minor,
                   GREATEST(COALESCE(charged.collectable_minor, 0)
                              - COALESCE(refunded.sum_minor, 0)
                              - COALESCE(refunded.voided_minor, 0)
                              - plan.price_minor, 0)::bigint AS floor_minor
          ) gross
          WHERE tm.team_id = p_team_id
            -- ACTIVE members only. The reminder CTEs in FeeAssignmentsRepository already scope on
            -- tm.active and so does every DM path; billing a deactivated member a season fee they
            -- will never be told about is money nobody can collect. (training_period_charges needs
            -- no such filter because an inactive member has no confirmed attendance to charge for;
            -- a membership price is owed by EXISTING, so here the filter is load-bearing.)
            AND tm.active
        $$
      `,
    ),

    // ---- Step 9: the writer --------------------------------------------------------------------
    // ONE function, FIVE statements, and THE STATEMENT ORDER IS THE LOCK ORDER (root AGENTS.md
    // invariant 2, as extended by 1793900000's `seasons -> fees` leg):
    //
    //   seasons (S0, row FOR UPDATE)
    //     -> fees (S1 insert, S2 mutex FOR UPDATE id ASC)
    //       -> member_credit_accounts (S3a upsert, S3b one ordered FOR UPDATE)
    //         -> member_credit_deposits (S3c)
    //           -> fee_assignments (S4)
    //
    // That is the canonical order, prefix-complete, with no statement revisiting an earlier table.
    // It is also why this is five SET-BASED statements and not a FOR..LOOP over members: a loop
    // would take fee_assignments for a charging member and then member_credit_accounts for the
    // next, refunding one -- an inversion inside a single function body, and a 40P01 on a money
    // write the moment two teams' sweeps interleave.
    //
    // root AGENTS.md line 51 warned that "the billing ticket is the thing most likely to break
    // this ... it will be tempted to lock fees and then write seasons". It does the opposite: it
    // takes `seasons` FIRST and never writes a season at all.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION recompute_membership_season_fees(p_team_id UUID) RETURNS void AS $$
        DECLARE
          v_recorder  UUID;
          v_season_id UUID;
          v_tz        TEXT;
          v_due_at    TIMESTAMPTZ;
        BEGIN
          -- Gate 1: the opt-in, which is also the user every credit row below is recorded under.
          -- team_settings is a one-to-one extension that may not exist for a team -- SELECT INTO
          -- leaves v_recorder NULL in that case, which is the same answer as "not opted in".
          SELECT ts.membership_billing_by_user_id INTO v_recorder
            FROM team_settings ts WHERE ts.team_id = p_team_id;
          IF v_recorder IS NULL THEN RETURN; END IF;

          -- Gate 2: THE RUNNING SEASON, AND THE NULL-SEASON SKIP. One lookup, stated as its
          -- own branch so deleting it is a visible change rather than an invisible join-shape
          -- edit.
          --
          -- BILLING DOES NOT USE governing_season_id, AND THAT IS THE WHOLE POINT OF THIS BLOCK.
          -- governing_season_id answers "which season is the member PICKING for". Billing needs
          -- "which season is RUNNING". They are different questions and they give different
          -- answers for months at a time: 1793900000:208-229 orders candidates
          -- is_open DESC, rank ASC, so an OPEN queued season beats a CLOSED current one -- and
          -- a queued season is normally open, that being the entire point of queueing it.
          --
          -- An earlier draft used governing_season_id plus a starts_at <= now() guard, and the
          -- sentence justifying it ("if the queued season's window is also closed the tie-break
          -- returns the current one, so the queued one is unreachable until it starts") was FALSE
          -- for the common case -- it only covers a CLOSED queued season. The consequence was a
          -- silent, months-long outage on a money feature:
          --   * 2027-02-01  the live season S1's window closes. Billing still normal.
          --   * 2027-03-01  the manager queues S2 for September with no deadline (legal, and
          --                 1793900000:41 documents it as "stays open"). is_open(S2) = true,
          --                 is_open(S1) = false -> governing = S2 -> the guard returns early and
          --                 BILLING IS OFF FOR THE LIVE SEASON. No error, no log, no surface.
          --   * 2027-04-15  a member downgrades. No refund. A member joins. No charge.
          --   * 2027-09-01  S2 starts; billing resumes keyed on S2. charged and refunded are
          --                 scoped to p_season_id, so S1's missing charges and missing refunds
          --                 are NEVER recomputed. Permanently lost. For a 25-member squad on a
          --                 1500 plan that is 37 500 Kc never billed.
          --
          -- The lookup below is immune: a future season is simply not a candidate, so the storm
          -- the old guard was protecting against (billing every non-selector the default plan's
          -- price before the season begins -- see 6) is closed just as hard, while the live
          -- season can never be frozen by something queued behind it.
          --
          -- It rides UNIQUE (team_id, starts_at) scanned backwards from now(), which
          -- 1793900000:46-48 records as existing for exactly this shape of query. No new index.
          --
          -- NULL means the team has no season that has started -- either zero seasons at all, or
          -- only future ones. seed_first_season_trg makes the first unreachable in practice, but
          -- BILLING MUST NOT TRUST AN INVARIANT IT DOES NOT OWN. The answer for both is the same
          -- and is the user's rule: write NOTHING. No fee, no fallback to now(), no synthesised
          -- season. An under-charge a manager fixes by creating a season beats a charge keyed on
          -- an instant nobody chose.
          SELECT s.id INTO v_season_id
            FROM seasons s
           WHERE s.team_id = p_team_id AND s.starts_at <= now()
           ORDER BY s.starts_at DESC
           LIMIT 1;
          IF v_season_id IS NULL THEN RETURN; END IF;

          -- PRE-CHECK BEFORE ANY LOCK, same shape as events_training_recompute's EXISTS guard and
          -- seasons_recompute's. This is what makes the steady state -- which is every tick after
          -- the first of each season -- completely lock-free: nothing owes anything, nothing is
          -- owed back, return before touching a single row. Without it a per-minute cron would
          -- take a seasons row lock and the team-wide fees mutex 1440 times a day to do nothing.
          IF NOT EXISTS (
            SELECT 1 FROM membership_season_charges(p_team_id, v_season_id) c
             WHERE c.delta_minor <> 0
          ) THEN RETURN; END IF;

          -- S0: the per-(team, season) mutex, taken on the SEASONS row.
          --
          -- DEFENSIVE, NOT A FIX FOR A DEMONSTRATED RACE -- stated the way root AGENTS.md:53
          -- states the same thing about recompute_training_period_fees' own mutex, and for the
          -- same reason: the distinction matters to whoever next touches it. Postgres already
          -- serialises the two sessions one layer down, on BOTH paths:
          --   * S4's accumulating DO UPDATE is reachable only when an assignment already exists,
          --     which means its shell already exists -- and S2 below takes FOR UPDATE on exactly
          --     that shell, so session 2 blocks until session 1 commits and then recomputes
          --     delta = 0 off a fresh READ COMMITTED snapshot.
          --   * On the FIRST tick of a season there is no shell, so S1's ON CONFLICT DO NOTHING
          --     makes session 2 wait on the speculative insert against
          --     idx_fees_team_season_plan_currency instead -- and it waits to COMMIT, not merely
          --     to speculative confirmation (check_exclusion_or_unique_constraint takes
          --     SpeculativeInsertionWait, then XactLockTableWait on retry).
          --   * On a REFUND-ONLY tick neither of those fires -- if the only shell is archived, S2
          --     locks an empty set and S1 inserts nothing. S3b's ordered
          --     member_credit_accounts ... FOR UPDATE is what serialises that path, after which
          --     S3c's fresh snapshot (new statement, VOLATILE plpgsql body) recomputes 0.
          -- S2 is also not plan-filtered, which matters more than the "not filtered on currency"
          -- note below says: two sessions resolving DIFFERENT plans for the same member still
          -- contend on the same shell set.
          --
          -- NOTHING ELSE CONTENDS, checked so the next person does not have to:
          -- recompute_training_period_fees' own mutex is kind='training'-scoped (1793200000:193)
          -- and it never touches member_credit_*; and team_members_plan_recompute_trg's UPDATE on
          -- team_members takes FOR NO KEY UPDATE, which does not conflict with S4's implicit
          -- FOR KEY SHARE.
          -- It is kept because it gives S0-S4 one view of the season, and because dropping a lock
          -- from a money path on the strength of "I could not break it" is a bad trade. Do NOT
          -- cite a proven lost update as its justification, and do not expect B20 to go red when
          -- it is removed -- B20 is a regression test for the accumulate arithmetic, not an
          -- isolation test for this lock.
          --
          -- It is on the SEASONS row, not a fees row, because on the first tick of a season there
          -- is no fees row yet -- a mutex that only exists once the work is done serialises
          -- nothing. The seasons row always exists (Gate 2 just resolved it) and is exactly one
          -- per key.
          --
          -- It also ESTABLISHES rather than inverts the documented seasons -> fees order:
          -- seasons_recompute_trg fires holding the season row it just wrote and then takes the
          -- fees mutex, which is the same direction.
          PERFORM 1 FROM seasons s WHERE s.id = v_season_id FOR UPDATE;
          IF NOT FOUND THEN RETURN; END IF;

          SELECT ts.timezone INTO v_tz FROM team_settings ts WHERE ts.team_id = p_team_id;
          IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;

          -- Due 14 days out, team-local midnight. Recomputed on EVERY call and written at BOTH
          -- levels -- the shell in S1 and each assignment in S4 -- so a member who lands on an
          -- existing shell months later gets 14 days from THEIR assignment, not from the shell's
          -- birth. INSERT ONLY at both levels (neither S1's ON CONFLICT nor S4's touches it), so a
          -- treasurer's own edit to either sticks. Same rule recompute_training_period_fees
          -- follows for its own v_due_at.
          --
          -- THE DUE DATE MUST BE IN THE FUTURE, and the reason is the opposite of the obvious one.
          -- fee_assignment_status_v's effective_due_at is COALESCE(fa.due_at, f.due_at), so
          -- without the S4 half a member assigned on 1 Nov to a shell created on 1 Sep is
          -- overdue the instant they are billed -- counted in the team's overdue KPI and shown
          -- as overdue on their own payments page.
          --
          -- And they would never be REMINDED of it, which is worse than being reminded too much.
          -- FeeAssignmentsRepository's reminder ladder matches day_diff on EXACT EQUALITY
          -- (= -3, = 0, = 3, = 10, = 21), not >=. A fee born 47 days overdue matches no rung and
          -- fires NOTHING, ever: a silent debt. A fee born exactly 3, 10 or 21 days overdue fires
          -- that one rung immediately at every affected member and then goes quiet for good,
          -- skipping every earlier rung. A future due date is the only anchor under which a
          -- member passes through the whole ladder in order.
          --
          -- NOT the season's selection_deadline and NOT its starts_at, for exactly that reason:
          -- both are routinely already in the past by the time a given member is billed.
          v_due_at := (date_trunc('day', now() AT TIME ZONE v_tz) + INTERVAL '14 days')
                        AT TIME ZONE v_tz;

          -- S1: the shell(s). One per (plan, currency) that somebody owes something for -- NEVER
          -- one per member, and never an empty shell "ready" for a plan nobody is on. Shells are
          -- never deleted, so an unneeded one is permanent clutter on the fees page.
          --
          -- amount_minor = 0 on the shell, with the real figure on each assignment: identical to
          -- a training fee, so FinancesOverviewPage and the assignment list behave the same way.
          --
          -- The name is LOCALE-FREE. membership_plans.name is NULL for the seeded default plan
          -- ("render the built-in translated label", 1792800000), and freezing a translated
          -- literal into a row is the exact thing that migration forbids -- so an unnamed plan
          -- yields just the season date. The treasurer can rename it; updateFee allows a name
          -- change on a generated fee, only currency is refused.
          INSERT INTO fees (team_id, kind, season_id, membership_plan_id, name,
                            amount_minor, currency, due_at, target_scope)
          SELECT DISTINCT
                 p_team_id, 'membership', v_season_id, c.membership_plan_id,
                 COALESCE(mp.name || ' ', '')
                   || to_char(s.starts_at AT TIME ZONE v_tz, 'YYYY-MM-DD'),
                 0, c.currency, v_due_at, 'custom'
          FROM membership_season_charges(p_team_id, v_season_id) c
          JOIN membership_plans mp ON mp.id = c.membership_plan_id
          JOIN seasons s ON s.id = v_season_id
          WHERE c.delta_minor > 0
          -- The predicate is restated because the index is partial, and it must stay
          -- character-identical to idx_fees_team_season_plan_currency's -- Step 4 records what
          -- breaks otherwise, and why the index is archived-filtered in the first place.
          ON CONFLICT (team_id, season_id, membership_plan_id, currency)
            WHERE kind = 'membership' AND archived_at IS NULL DO NOTHING;

          -- S2: the fees mutex, id ASC -- the canonical outermost leg, same as
          -- recompute_training_period_fees' S1 and taken for the same reason: it gives S1..S4 one
          -- view of the season. MUST come AFTER S1 so a concurrent creator has already been
          -- serialised by the unique index and its row is visible to this fresh READ COMMITTED
          -- snapshot.
          --
          -- NOT filtered on currency or plan: a member whose plan currency changed mid-season
          -- leaves a row under the OLD currency's fee, and only an unfiltered lock covers it.
          PERFORM 1 FROM fees f
           WHERE f.team_id = p_team_id AND f.kind = 'membership' AND f.season_id = v_season_id
             AND f.archived_at IS NULL
           ORDER BY f.id FOR UPDATE;

          -- S3a: every account row a refund will touch must EXIST before it can be locked, and
          -- member_credit_deposits has an FK onto (team_member_id, currency). A member who has
          -- never held credit has no row. Balance 0 -- the deposit in S3c and the UPDATE beside it
          -- put the money in.
          --
          -- S3a AND S3c EACH RESOLVE THE REFUND SET ON THEIR OWN READ COMMITTED SNAPSHOT, and
          -- the window between them is open: nothing in this transaction blocks a plan change
          -- (the Discord picker, #748 -- and team_members_plan_recompute_trg only touches
          -- kind='training' fees). A member who is delta = 0 here, has never held credit, and
          -- downgrades before S3c runs gets a deposit with no account row behind it:
          -- member_credit_deposits_team_member_id_currency_fkey, 23503, rolling back the WHOLE
          -- call -- every shell and every other member's refund with it.
          --
          -- TOLERATED, not overlooked, and bounded at ONE TICK. This function is a pure
          -- derivation: the cron isolates the team and logs, and on the next tick that member is
          -- delta < 0 HERE too, so S3a mints their account and the refund lands. Lost latency,
          -- never lost money. It is the same shape as the residual root AGENTS.md already
          -- accepts for unmatch's account hoist.
          -- The fix would be dropping the WHERE c.delta_minor < 0 below and minting a zero-balance
          -- account for every candidate. REJECTED, for the reason AGENTS.md gives for the
          -- sibling case plus one more: it writes a row per active member per currency for every
          -- team that will never hold credit, and it STILL does not close the window -- a member
          -- REACTIVATED between S3a and S3c is a candidate at S3c and at neither point here.
          -- Revisit if the 23503 is ever actually observed in the cron's logs.
          INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
          SELECT c.team_member_id, c.currency, 0
          FROM membership_season_charges(p_team_id, v_season_id) c
          WHERE c.delta_minor < 0
          ON CONFLICT (team_member_id, currency) DO NOTHING;

          -- S3b: ONE ordered statement taking EVERY account lock this call needs, before any
          -- deposit or assignment write. root AGENTS.md calls this an ACQUISITION RULE, not a
          -- resource ranking: a path that takes account locks at all must take them all at once,
          -- in (team_member_id, currency) order, or two sweeps over overlapping member sets
          -- interleave and deadlock.
          PERFORM 1 FROM member_credit_accounts a
           WHERE (a.team_member_id, a.currency) IN (
             SELECT c.team_member_id, c.currency
             FROM membership_season_charges(p_team_id, v_season_id) c
             WHERE c.delta_minor < 0
           )
           ORDER BY a.team_member_id, a.currency FOR UPDATE;

          -- S3c: the downgrade refund -- deposit row and balance bump in ONE statement.
          --
          -- ONE STATEMENT IS MANDATORY, not tidiness. membership_season_charges reads
          -- member_credit_deposits, so a separate UPDATE would re-call it AFTER the INSERT
          -- committed its rows to this snapshot, see delta = 0 for exactly the members just
          -- refunded, bump nothing, and break the §2.4 reconciliation identity
          -- (balance = deposits - credit payments) silently. The CTE is evaluated once, so the
          -- RETURNING set is the deposit set by construction.
          --
          -- method 'bank_transfer': member_credit_deposits.method is CHECK-constrained to
          -- ('cash','bank_transfer') and the wire schema (ManualPaymentMethod, FinanceApi:118)
          -- is a closed union its own comment says is never widened. 'bank_transfer' is the
          -- precedent BankTransactionMatcher.writeAutoCredit already uses for a system-minted
          -- deposit. source = 'auto' is what the UI actually renders ("automatic"), and it is
          -- also what suppresses a recorder name.
          --
          -- note stays NULL: a note is free text with no locale context inside SQL, and
          -- 1792800000 forbids freezing a translated literal into a row.
          --
          -- NO CLAMP IS NEEDED on the balance. CHECK (balance_minor >= 0) can only be violated by
          -- a decrement, and this only ever adds.
          WITH refunds AS (
            SELECT c.team_member_id, c.currency, (-c.delta_minor)::bigint AS amount_minor
            FROM membership_season_charges(p_team_id, v_season_id) c
            WHERE c.delta_minor < 0
          ),
          ins AS (
            INSERT INTO member_credit_deposits
              (team_member_id, currency, amount_minor, method, paid_at,
               recorded_by_user_id, source, season_id)
            SELECT r.team_member_id, r.currency, r.amount_minor, 'bank_transfer', now(),
                   v_recorder, 'auto', v_season_id
            FROM refunds r
            RETURNING team_member_id, currency, amount_minor
          )
          UPDATE member_credit_accounts a
             SET balance_minor = a.balance_minor + i.amount_minor, updated_at = now()
          FROM ins i
          WHERE a.team_member_id = i.team_member_id AND a.currency = i.currency;

          -- S4: the charge. Innermost leg, after every account lock, exactly where
          -- fee_assignments belongs.
          --
          -- S3c moved refunded for the members it paid back, so this call to
          -- membership_season_charges now returns delta = 0 for them -- they are filtered out by
          -- > 0 and cannot be double-handled. Charging members are untouched by S3.
          --
          -- WHAT ARCHIVING A SHELL DOES, AND WHAT IT MUST NOT DO. Two earlier drafts of this
          -- comment credited the wrong mechanism, so, precisely: archiving cancels the charge
          -- for the members ALREADY ASSIGNED under that shell, and for nobody else.
          --   * already assigned -- charged.sum_minor counts archived rows (Step 8), so their
          --     delta is 0 and this statement writes nothing for them. That sum is the entire
          --     mechanism; the index is not part of it.
          --   * never assigned -- S1 has created a FRESH live shell for them, because
          --     idx_fees_team_season_plan_currency is archived-filtered, and they are billed
          --     here exactly once. Archiving one shell must never silently un-bill every future
          --     member of that plan for the rest of the season; it used to, and Step 4 records
          --     the repro.
          -- archived_at IS NULL on this join stays, and now does ONE job rather than two: it
          -- keeps the assignment off the dead shell and onto the live replacement. An assignment
          -- under an archived fee is hidden from the member by findByTeamMember and matched by
          -- neither reminder CTE -- a debt nobody is ever told about.
          -- The REFUND side is bounded by something else again: the FLOOR in
          -- membership_season_charges, computed from collectable_minor (archived and waived rows
          -- excluded) rather than from the raw charged sum.
          --
          -- DO UPDATE, accumulating, not DO NOTHING. The normal reassignment path never reaches
          -- it -- an upgrade lands on a DIFFERENT plan's shell, which is the whole point of
          -- keying the shell on the plan. It fires only when a member RETURNS to a plan they
          -- already hold an assignment under (A -> B -> C -> A within one season), where
          -- DO NOTHING would silently leave them under-billed by the gap forever. It only ever
          -- ADDS, so amount_minor can never fall below paid_minor and the member is never
          -- re-billed downward -- the property Decision 3's never-rewrite rule is protecting.
          -- Two concurrent ticks are serialised here by S2's FOR UPDATE on the shell this branch
          -- is about to touch -- not by S0, which is defensive (see its own comment). B20 pins
          -- the arithmetic; nothing isolates S0.
          --
          -- due_at IS IN THE INSERT LIST AND NOT IN THE DO UPDATE SET. In the list because
          -- effective_due_at is COALESCE(fa.due_at, f.due_at) and a late joiner on an old shell
          -- would otherwise inherit a date months in the past; out of the SET because a
          -- treasurer's own edit must survive the next tick -- the same split the shell follows.
          INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor, due_at)
          SELECT f.id, c.team_member_id, c.delta_minor, v_due_at
          FROM membership_season_charges(p_team_id, v_season_id) c
          JOIN fees f ON f.team_id = p_team_id
                     AND f.kind = 'membership'
                     AND f.season_id = v_season_id
                     AND f.membership_plan_id = c.membership_plan_id
                     AND f.currency = c.currency
                     AND f.archived_at IS NULL
          WHERE c.delta_minor > 0
          ON CONFLICT (fee_id, team_member_id) DO UPDATE
            SET amount_minor = fee_assignments.amount_minor + EXCLUDED.amount_minor,
                updated_at = now();
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
  ),
);
