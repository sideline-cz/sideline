import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_sync_config (
          team_id                   UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          provider                  TEXT NOT NULL DEFAULT 'fio' CHECK (provider IN ('fio')),
          enabled                   BOOLEAN NOT NULL DEFAULT false,
          auto_match_enabled        BOOLEAN NOT NULL DEFAULT true,

          -- Account identity (feeds the pure CZ IBAN builder -> SPAYD ACC)
          account_prefix            TEXT CHECK (account_prefix IS NULL OR account_prefix ~ '^[0-9]{1,6}$'),
          account_number            TEXT CHECK (account_number IS NULL OR account_number ~ '^[0-9]{2,10}$'),
          bank_code                 TEXT CHECK (bank_code IS NULL OR bank_code ~ '^[0-9]{4}$'),
          iban                      TEXT,        -- cached from Fio info.iban, cross-check only
          currency                  CHAR(3) NOT NULL DEFAULT 'CZK',

          -- Organisation identity, printed on the PDF (D13 / design 7.4)
          recipient_name            TEXT,
          registered_id             TEXT CHECK (registered_id IS NULL OR registered_id ~ '^[0-9]{8}$'),
          registered_address        TEXT,
          bank_name                 TEXT,

          -- Secret (AES-256-GCM, v1.<iv>.<tag>.<ct> base64url). Plain TEXT column.
          fio_token_encrypted       TEXT,
          fio_token_created_at      TIMESTAMPTZ,

          -- Backfill walk (bounded loop writes the cursor after each chunk)
          backfill_from             DATE,
          backfill_cursor           DATE,
          backfill_status           TEXT CHECK (backfill_status IS NULL OR backfill_status IN
                                      ('running','complete','history_locked','budget','failed')),
          backfill_run_id           UUID,

          -- Status / backoff bookkeeping
          last_synced_at            TIMESTAMPTZ,
          last_success_at           TIMESTAMPTZ,
          last_error_code           TEXT,
          last_error_at             TIMESTAMPTZ,
          consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at           TIMESTAMPTZ,
          coverage_warning          TEXT,

          -- Distributed poll lease (D10b)
          poll_leased_until         TIMESTAMPTZ,
          poll_leased_by            TEXT,

          configured_by_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

          -- An enabled config must be complete enough to poll, to build an IBAN, and to emit
          -- a SPAYD payload (RN) and a PDF header.
          CHECK (NOT enabled OR (account_number IS NOT NULL
                             AND bank_code IS NOT NULL
                             AND recipient_name IS NOT NULL))
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_sync_config_pollable
          ON bank_sync_config (team_id)
          WHERE enabled = true AND fio_token_encrypted IS NOT NULL
      `,
    ),
    // Per-token 30 s throttle, shared across replicas (D10b(a)).
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS fio_token_throttle (
          token_fingerprint    TEXT PRIMARY KEY,
          next_call_allowed_at TIMESTAMPTZ NOT NULL
        )
      `,
    ),
    // Coverage evidence for the export (D13).
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_statement_periods (
          team_id               UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          date_start            DATE NOT NULL,
          date_end              DATE NOT NULL,
          opening_balance_minor BIGINT NOT NULL,
          closing_balance_minor BIGINT NOT NULL,
          currency              CHAR(3) NOT NULL,
          fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (team_id, date_start, date_end)
        )
      `,
    ),
  ),
);
