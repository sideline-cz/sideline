import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id                UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          provider               TEXT NOT NULL DEFAULT 'fio' CHECK (provider IN ('fio')),

          fio_movement_id        BIGINT NOT NULL,   -- column22, up to 11 digits, never int4
          fio_order_id           TEXT,              -- column17, NOT unique, never reconciled on

          booked_on              DATE NOT NULL,     -- column0, first 10 chars
          amount_minor           BIGINT NOT NULL CHECK (amount_minor <> 0),  -- signed
          direction               TEXT GENERATED ALWAYS AS
                                   (CASE WHEN amount_minor < 0 THEN 'outgoing' ELSE 'incoming' END) STORED,
          currency               CHAR(3) NOT NULL,  -- column14

          variable_symbol        TEXT,   -- column5
          constant_symbol        TEXT,   -- column4
          specific_symbol        TEXT,   -- column6

          counterparty_account   TEXT,   -- column2
          counterparty_bank_code TEXT,   -- column3
          counterparty_name      TEXT,   -- column10
          counterparty_bank_name TEXT,   -- column12
          counterparty_bic       TEXT,   -- column26
          payer_reference        TEXT,   -- column27

          message_for_recipient  TEXT,   -- column16
          user_identification    TEXT,   -- column7
          tx_type                TEXT,   -- column8
          entered_by              TEXT,   -- column9
          specification           TEXT,   -- column18
          comment                 TEXT,   -- column25

          match_state            TEXT NOT NULL DEFAULT 'unmatched'
                                   CHECK (match_state IN ('unmatched','partially_matched','matched',
                                                          'ignored','not_applicable')),
          -- Exactly the nine literals of BankTransactionMatchReason. possible_duplicate is a hint,
          -- not a reason, and is deliberately absent.
          match_reason           TEXT
                                   CHECK (match_reason IS NULL OR match_reason IN
                                     ('no_vs','no_member_for_vs','ambiguous_member','amount_mismatch_under',
                                      'overpayment','ambiguous_multiple_exact','ambiguous_multiple_open',
                                      'no_open_assignment','currency_mismatch')),
          match_evidence          JSONB,   -- what the engine considered and why (D5, B6)
          auto_match_suppressed   BOOLEAN NOT NULL DEFAULT false,  -- set by /unmatch, cleared by a manual match

          ignored_reason          TEXT,
          ignored_by_user_id      UUID REFERENCES users(id) ON DELETE RESTRICT,
          -- Discriminates the two flavours of 'ignored' so the audit export can print
          -- "Jiný příjem klubu" instead of "Ignorováno" next to a large municipal grant.
          resolution_kind         TEXT CHECK (resolution_kind IS NULL OR resolution_kind IN
                                   ('other_income','not_relevant')),

          raw                    JSONB NOT NULL,
          ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

          CHECK (match_state <> 'ignored'
                 OR (ignored_reason IS NOT NULL AND ignored_by_user_id IS NOT NULL
                     AND resolution_kind IS NOT NULL)),
          CHECK (match_state = 'ignored' OR resolution_kind IS NULL),
          UNIQUE (team_id, provider, fio_movement_id)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_transactions_team_booked
          ON bank_transactions (team_id, booked_on DESC, id DESC)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_transactions_queue
          ON bank_transactions (team_id, booked_on DESC)
          WHERE match_state IN ('unmatched','partially_matched')
      `,
    ),
    // duplicate-hint lookup (S4 step 2.5)
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_transactions_dup
          ON bank_transactions (team_id, variable_symbol, amount_minor, booked_on)
          WHERE direction = 'incoming'
      `,
    ),

    // ---- D7: one payment -> one bank transaction ---------------------------
    Effect.tap(
      () => sql`
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_transaction_id UUID
          REFERENCES bank_transactions(id) ON DELETE RESTRICT
      `,
    ),
    Effect.tap(() => sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_by TEXT`),
    Effect.tap(
      () => sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_matched_by_values') THEN
            ALTER TABLE payments ADD CONSTRAINT payments_matched_by_values
              CHECK (matched_by IS NULL OR matched_by IN ('auto','manual'));
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_bank_match_pair') THEN
            ALTER TABLE payments ADD CONSTRAINT payments_bank_match_pair
              CHECK ((bank_transaction_id IS NULL AND matched_by IS NULL)
                  OR (bank_transaction_id IS NOT NULL AND matched_by IS NOT NULL));
          END IF;
        END $$
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_payments_bank_transaction
          ON payments (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL
      `,
    ),

    // ---- D7b: match_state is trigger-maintained, consolidated with paid_minor ----
    // Human-set terminal states ('ignored','not_applicable') are never overwritten by payment
    // activity.
    //
    // `CREATE OR REPLACE FUNCTION` only replaces a function with the IDENTICAL argument list —
    // Postgres treats a different arg count as a distinct overload, not a replacement. This
    // migration originally shipped a one-argument `recompute_bank_match_state(UUID)`; the
    // `p_void_suppress` parameter below was added later (BLOCKER 2). Drop that earlier signature
    // first so a database that already ran the one-arg version of this same migration id ends up
    // with exactly one overload, not two — a stray one-arg overload would silently resolve every
    // positional-only call site (there are several) back to the pre-fix body forever.
    Effect.tap(() => sql`DROP FUNCTION IF EXISTS recompute_bank_match_state(UUID)`),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION recompute_bank_match_state(
          p_tx_id UUID, p_void_suppress BOOLEAN DEFAULT false
        ) RETURNS void AS $$
        DECLARE v_amount BIGINT; v_state TEXT; v_matched BIGINT;
        BEGIN
          SELECT abs(amount_minor), match_state INTO v_amount, v_state
          FROM bank_transactions WHERE id = p_tx_id FOR UPDATE;
          IF NOT FOUND THEN RETURN; END IF;
          IF v_state IN ('ignored','not_applicable') THEN
            -- Still stamp the suppression flag even on a terminal row: an unignore later must
            -- not immediately re-invite the poller to re-match a movement whose payment was
            -- just voided.
            IF p_void_suppress THEN
              UPDATE bank_transactions
                 SET auto_match_suppressed = true, updated_at = now()
               WHERE id = p_tx_id;
            END IF;
            RETURN;
          END IF;

          SELECT COALESCE(SUM(p.amount_minor), 0)::BIGINT INTO v_matched
          FROM payments p WHERE p.bank_transaction_id = p_tx_id AND p.voided_at IS NULL;

          -- p_void_suppress is set exactly once, by payments_finance_recompute(), when a
          -- payment on this transaction just transitioned from active to voided (covers
          -- /unmatch, voidPayment, and any future void path with one rule, in the same UPDATE
          -- and under the same row lock recompute_bank_match_state already holds).
          UPDATE bank_transactions
             SET match_state = CASE WHEN v_matched = 0 THEN 'unmatched'
                                    WHEN v_matched >= v_amount THEN 'matched'
                                    ELSE 'partially_matched' END,
                 auto_match_suppressed = CASE WHEN p_void_suppress THEN true
                                              ELSE auto_match_suppressed END,
                 updated_at = now()
           WHERE id = p_tx_id;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    // Replaces payments_recompute_trigger(). Same paid_minor semantics, plus the bank match
    // state, with the lock order (bank_transactions -> fee_assignments) explicit in the code
    // rather than implied by two trigger names sorting a particular way.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION payments_finance_recompute() RETURNS trigger AS $$
        DECLARE a UUID; b UUID; fa_a UUID; fa_b UUID; v_void_suppress BOOLEAN;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.bank_transaction_id IS NOT NULL THEN
              PERFORM recompute_bank_match_state(OLD.bank_transaction_id);
            END IF;
            PERFORM recompute_paid_minor(OLD.fee_assignment_id);
            RETURN OLD;
          END IF;

          -- A payment on a bank-matched row just transitioned from active to voided (covers
          -- /unmatch, voidPayment, and any future void path with one rule): the transaction
          -- must not be silently re-picked up by the poller within its rolling window, so stamp
          -- auto_match_suppressed = true in the same UPDATE recompute_bank_match_state already
          -- performs under the row lock.
          v_void_suppress := (
            TG_OP = 'UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
            AND NEW.bank_transaction_id IS NOT NULL
          );

          -- When a payment is re-pointed between two bank transactions, lock the LOWER id first
          -- so two concurrent re-points in opposite directions cannot self-deadlock.
          IF TG_OP = 'UPDATE' AND OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id
             AND OLD.bank_transaction_id IS NOT NULL AND NEW.bank_transaction_id IS NOT NULL THEN
            a := LEAST(OLD.bank_transaction_id, NEW.bank_transaction_id);
            b := GREATEST(OLD.bank_transaction_id, NEW.bank_transaction_id);
            PERFORM recompute_bank_match_state(a, v_void_suppress AND a = NEW.bank_transaction_id);
            PERFORM recompute_bank_match_state(b, v_void_suppress AND b = NEW.bank_transaction_id);
          ELSE
            IF NEW.bank_transaction_id IS NOT NULL THEN
              PERFORM recompute_bank_match_state(NEW.bank_transaction_id, v_void_suppress);
            END IF;
            IF TG_OP = 'UPDATE' AND OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id
               AND OLD.bank_transaction_id IS NOT NULL THEN
              PERFORM recompute_bank_match_state(OLD.bank_transaction_id);
            END IF;
          END IF;

          -- Same LEAST/GREATEST deadlock-avoidance as the bank_transaction_id branch above,
          -- applied to the sibling re-point case: a payment moved between two fee_assignments.
          -- Unreachable today (nothing re-points fee_assignment_id), inherited from the original
          -- trigger, but kept symmetric with its sibling on the same principle.
          IF TG_OP = 'UPDATE' AND OLD.fee_assignment_id <> NEW.fee_assignment_id THEN
            fa_a := LEAST(OLD.fee_assignment_id, NEW.fee_assignment_id);
            fa_b := GREATEST(OLD.fee_assignment_id, NEW.fee_assignment_id);
            PERFORM recompute_paid_minor(fa_a);
            PERFORM recompute_paid_minor(fa_b);
          ELSE
            PERFORM recompute_paid_minor(NEW.fee_assignment_id);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    // No trigger name is load-bearing any more. The order is the order of the PERFORM
    // statements inside payments_finance_recompute(). The old payments_recompute_trigger()
    // function is left in place (unreferenced) so a rollback can re-create its trigger.
    Effect.tap(() => sql`DROP TRIGGER IF EXISTS payments_recompute_paid_minor ON payments`),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER payments_finance_recompute
          AFTER INSERT OR UPDATE OR DELETE ON payments
          FOR EACH ROW EXECUTE FUNCTION payments_finance_recompute()
      `,
    ),
  ),
);
