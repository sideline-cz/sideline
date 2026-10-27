import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.all(
    [
      // Single-use exchange tokens for the bot's `/login` command. The plaintext never
      // reaches this table — only `sha256(token)`, same as `team_onboarding_tokens`.
      // The row IS the audit record: who asked, from which guild, whether it was used,
      // and which session it minted.
      sql`CREATE TABLE discord_login_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash TEXT NOT NULL UNIQUE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        issued_from_guild_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
      )`,

      // Drives the revoke-outstanding sweep that runs on every issuance: one row per
      // user at most, so the partial index stays tiny.
      sql`CREATE INDEX idx_discord_login_tokens_outstanding
        ON discord_login_tokens (user_id)
        WHERE consumed_at IS NULL AND revoked_at IS NULL`,
    ],
    { concurrency: 1 },
  ),
);
