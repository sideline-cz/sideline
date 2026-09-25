import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Links an expense back to the outgoing bank movement it came from. `UNIQUE` is the duplicate
// guard: Postgres allows many NULLs under a unique constraint, so hand-entered expenses are
// unaffected, but one movement can never produce two expenses. There is deliberately no
// application-level "already expensed?" check — the constraint is the whole mechanism, which is
// what makes the poller's auto-create path idempotent under re-import.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE expenses
          ADD COLUMN IF NOT EXISTS bank_transaction_id UUID
            REFERENCES bank_transactions(id) ON DELETE RESTRICT
      `,
    ),
    // Named explicitly (rather than letting Postgres pick `expenses_bank_transaction_id_key`) so
    // `ExpensesRepository` can catch this exact constraint by name via `catchUniqueViolationOn`.
    Effect.tap(
      () => sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_expenses_bank_transaction_id') THEN
            ALTER TABLE expenses
              ADD CONSTRAINT uq_expenses_bank_transaction_id UNIQUE (bank_transaction_id);
          END IF;
        END $$
      `,
    ),
    Effect.tap(
      () =>
        sql`COMMENT ON COLUMN expenses.bank_transaction_id IS 'The outgoing bank movement this expense was created from; NULL for hand-entered expenses. UNIQUE doubles as the duplicate guard — one movement, at most one expense. Deleting the expense frees the movement for a treasurer to expense again by hand; the poller will NOT re-create it (see the ingested_at floor in BankSyncPoller.autoCreateExpenses).'`,
    ),
  ),
);
