import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- the account: balance + the money lock -------------------------------
    // The balance is a stored column, never a SUM over a ledger. A row-level
    // SELECT ... FOR UPDATE over ledger rows locks only what the statement's snapshot
    // saw; under READ COMMITTED, EvalPlanQual re-reads a freed row but never rescans
    // the predicate for rows that did not exist when the statement began. Two
    // concurrent applications would each read 100 and each write -100. One durable
    // row per (member, currency) is what gives every settlement something to lock.
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS member_credit_accounts (
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
          currency       CHAR(3) NOT NULL,
          balance_minor  BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (team_member_id, currency)
        )
      `,
    ),
    // ---- history of every credit ADD (voidable) ------------------------------
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS member_credit_deposits (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_member_id      UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
          currency            CHAR(3) NOT NULL,
          amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
          method              TEXT NOT NULL CHECK (method IN ('cash','bank_transfer')),
          paid_at             TIMESTAMPTZ NOT NULL,
          note                TEXT,
          recorded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          voided_at           TIMESTAMPTZ,
          voided_by_user_id   UUID REFERENCES users(id) ON DELETE RESTRICT,
          void_reason         TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ((voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
              OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL)),
          FOREIGN KEY (team_member_id, currency)
            REFERENCES member_credit_accounts(team_member_id, currency) ON DELETE RESTRICT
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_member_credit_deposits_member
          ON member_credit_deposits (team_member_id, currency)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_member_credit_deposits_active
          ON member_credit_deposits (team_member_id, currency) WHERE voided_at IS NULL
      `,
    ),
    // ---- payments.method gains 'credit' --------------------------------------
    // System-minted only: a 'credit' payments row is written exclusively by
    // MemberCreditsRepository.settle, in the same transaction that debits the account.
    // The wire schema (ManualPaymentMethod) never accepts it, so no client can mint one.
    //
    // The lookup is pinned to the method CHECK specifically. A bare ILIKE '%method%'
    // with SELECT ... INTO (no STRICT, no LIMIT) silently takes an arbitrary row if a
    // second CHECK on payments ever mentions the word - and the consequence is dropping
    // the wrong constraint. Anchor on the definition's prefix and assert at most one match.
    Effect.tap(
      () => sql`
        DO $$
        DECLARE c TEXT; n INT;
        BEGIN
          SELECT count(*), min(conname) INTO n, c FROM pg_constraint
           WHERE conrelid = 'payments'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE 'CHECK ((method %';
          IF n > 1 THEN
            RAISE EXCEPTION 'expected at most one method CHECK on payments, found %', n;
          END IF;
          IF n = 1 THEN EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c); END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_method_values') THEN
            ALTER TABLE payments ADD CONSTRAINT payments_method_values
              CHECK (method IN ('cash','bank_transfer','credit'));
          END IF;
        END $$
      `,
    ),
  ),
);
