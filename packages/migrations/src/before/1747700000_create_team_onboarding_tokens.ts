import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.all(
    [
      // 1. Create team_onboarding_tokens table
      sql`CREATE TABLE team_onboarding_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      proposed_name TEXT NOT NULL,
      bound_discord_id TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_by UUID REFERENCES users(id),
      resulting_team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
      revoked_at TIMESTAMPTZ
    )`,

      // 2. Index for active token lookups by bound Discord user
      sql`CREATE INDEX idx_team_onboarding_tokens_bound_discord_id
      ON team_onboarding_tokens (bound_discord_id)
      WHERE consumed_at IS NULL AND revoked_at IS NULL`,
    ],
    { concurrency: 1 },
  ),
);
