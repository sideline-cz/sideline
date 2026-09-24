/**
 * "Players can top up their own credit from a standing QR code" — the schema half.
 *
 * Three independent changes, all backwards-compatible by construction:
 *
 * 1. `bank_sync_config.auto_credit_enabled` — OPT-IN, default false. Deliberately NOT a reuse of
 *    `auto_match_enabled`, which defaults to `true` and is therefore already on for every team:
 *    reusing it would silently retire five of the nine review-queue reasons
 *    (`amount_mismatch_under`, `overpayment`, `ambiguous_multiple_open`,
 *    `ambiguous_multiple_exact`, `no_open_assignment`) for clubs that never asked for it. With
 *    the new flag off, the matcher's decision table is byte-for-byte what it is today.
 *
 * 2. `member_credit_deposits.bank_transaction_id` + `source` — provenance, mirroring the
 *    `payments.bank_transaction_id` + `matched_by` pair added by `1792000002`. This is a
 *    CORRECTNESS requirement, not an audit nicety: `/unmatch` finds what to undo by
 *    `bank_transaction_id`, so without the link an unmatched (wrong-person, returned) transfer
 *    would leave phantom credit on the member's balance with nothing to find it by.
 *    `DEFAULT 'manual'` backfills every deposit written by #725 correctly — no data migration.
 *
 * 3. `recompute_bank_match_state` learns to count credit deposits. A transfer whose remainder
 *    becomes credit writes FEWER `payments` minor units than the transaction is worth, so the
 *    unextended function would park a fully-applied transfer at `partially_matched` (or
 *    `unmatched`, when the member owed nothing) — back in the very queue this feature exists to
 *    clear.
 */
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- 1. the opt-in flag ---------------------------------------------------
    Effect.tap(
      () => sql`
        ALTER TABLE bank_sync_config
          ADD COLUMN IF NOT EXISTS auto_credit_enabled BOOLEAN NOT NULL DEFAULT false
      `,
    ),

    // ---- 2. deposit provenance ------------------------------------------------
    Effect.tap(
      () => sql`
        ALTER TABLE member_credit_deposits
          ADD COLUMN IF NOT EXISTS bank_transaction_id UUID
            REFERENCES bank_transactions(id) ON DELETE RESTRICT
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE member_credit_deposits
          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
      `,
    ),
    // Both CHECKs added separately from the columns so a re-run over a database that already has
    // the columns still installs them. Mirrors `payments_matched_by_values` /
    // `payments_bank_match_pair` from 1792000002 exactly.
    Effect.tap(
      () => sql`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'member_credit_deposits_source_values') THEN
            ALTER TABLE member_credit_deposits ADD CONSTRAINT member_credit_deposits_source_values
              CHECK (source IN ('auto','manual'));
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'member_credit_deposits_bank_source_pair') THEN
            ALTER TABLE member_credit_deposits ADD CONSTRAINT member_credit_deposits_bank_source_pair
              CHECK ((source = 'manual' AND bank_transaction_id IS NULL)
                  OR (source = 'auto'   AND bank_transaction_id IS NOT NULL));
          END IF;
        END $$
      `,
    ),
    // `/unmatch` looks deposits up by transaction; the partial index keeps it off every
    // treasurer-recorded row.
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_member_credit_deposits_bank_tx
          ON member_credit_deposits (bank_transaction_id)
          WHERE bank_transaction_id IS NOT NULL
      `,
    ),

    // ---- 3. match_state counts credit deposits too -----------------------------
    // Same (UUID, BOOLEAN DEFAULT false) signature as 1792000002's version, so CREATE OR REPLACE
    // genuinely replaces rather than adding an overload. Only the `v_matched` computation
    // changes: it now sums active payments PLUS active credit deposits carrying this
    // transaction's id. Everything else — the terminal-state guard, the p_void_suppress rule,
    // the row lock — is byte-for-byte the original.
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
            IF p_void_suppress THEN
              UPDATE bank_transactions
                 SET auto_match_suppressed = true, updated_at = now()
               WHERE id = p_tx_id;
            END IF;
            RETURN;
          END IF;

          SELECT COALESCE((SELECT SUM(p.amount_minor) FROM payments p
                            WHERE p.bank_transaction_id = p_tx_id AND p.voided_at IS NULL), 0)
               + COALESCE((SELECT SUM(d.amount_minor) FROM member_credit_deposits d
                            WHERE d.bank_transaction_id = p_tx_id AND d.voided_at IS NULL), 0)
            INTO v_matched;

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

    // A deposit write must drive match_state the same way a payment write does. Mirrors
    // `payments_finance_recompute`'s bank half, minus the fee_assignments half (a deposit
    // touches no assignment) and minus the re-point branch (`bank_transaction_id` is immutable
    // on a deposit — nothing updates it).
    //
    // Lock order (root AGENTS.md invariant 2, `member_credit_accounts` -> `payments` ->
    // `bank_transactions` -> `fee_assignments`): this trigger takes `bank_transactions`, and
    // every writer of `member_credit_deposits` (settle, voidDeposit, the matcher's auto-credit
    // path) already holds the `member_credit_accounts` lock by the time it writes a deposit —
    // so the acquisition stays in canonical order.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION credit_deposits_bank_recompute() RETURNS trigger AS $$
        DECLARE v_void_suppress BOOLEAN;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.bank_transaction_id IS NOT NULL THEN
              PERFORM recompute_bank_match_state(OLD.bank_transaction_id);
            END IF;
            RETURN OLD;
          END IF;

          -- Same rule as payments: a deposit on a bank-matched row transitioning active ->
          -- voided must stop the poller re-picking the movement up inside its rolling window.
          v_void_suppress := (
            TG_OP = 'UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
            AND NEW.bank_transaction_id IS NOT NULL
          );

          IF NEW.bank_transaction_id IS NOT NULL THEN
            PERFORM recompute_bank_match_state(NEW.bank_transaction_id, v_void_suppress);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () =>
        sql`DROP TRIGGER IF EXISTS credit_deposits_bank_recompute_trigger ON member_credit_deposits`,
    ),
    Effect.tap(
      () => sql`
        CREATE TRIGGER credit_deposits_bank_recompute_trigger
          AFTER INSERT OR UPDATE OR DELETE ON member_credit_deposits
          FOR EACH ROW EXECUTE FUNCTION credit_deposits_bank_recompute()
      `,
    ),
  ),
);
