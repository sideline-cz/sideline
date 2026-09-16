import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_token_expiry_events (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          guild_id        text NOT NULL,
          user_discord_id text NOT NULL,
          threshold_days  integer NOT NULL,          -- 14 | 7 | 1
          token_expires_at timestamptz NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          processed_at    timestamptz,
          error           text
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_token_expiry_events_unprocessed
          ON bank_token_expiry_events (created_at) WHERE processed_at IS NULL
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_token_expiry_events_pending
          ON bank_token_expiry_events (team_id, threshold_days) WHERE processed_at IS NULL
      `,
    ),
    // Delivery log: T-14 / T-7 / T-1 must each fire exactly once per token generation. Keying on
    // token_created_at (not just team_id/threshold_days) means a replacement token re-arms all
    // three thresholds without a manual reset.
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_token_expiry_sent (
          team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          token_created_at timestamptz NOT NULL,
          threshold_days  integer NOT NULL,
          sent_at         timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (team_id, token_created_at, threshold_days)
        )
      `,
    ),
  ),
);
