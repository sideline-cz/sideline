import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE invite_acceptances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_invite_id UUID NOT NULL REFERENCES team_invites(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      discord_code TEXT,
      discord_code_error_code TEXT,
      discord_code_error_detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      generated_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX idx_invite_acceptances_discord_code
      ON invite_acceptances(discord_code)
      WHERE discord_code IS NOT NULL;

    CREATE INDEX idx_invite_acceptances_pending
      ON invite_acceptances(created_at)
      WHERE discord_code IS NULL AND discord_code_error_code IS NULL;

    CREATE INDEX idx_invite_acceptances_team_invite_id
      ON invite_acceptances(team_invite_id);

    DROP INDEX IF EXISTS idx_team_invites_discord_code;
    DROP INDEX IF EXISTS idx_team_invites_pending_discord_code;
    ALTER TABLE team_invites DROP COLUMN IF EXISTS discord_code;
  `,
);
