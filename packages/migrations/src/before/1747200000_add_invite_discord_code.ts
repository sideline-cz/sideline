import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE team_invites
      ADD COLUMN discord_code TEXT;

    CREATE UNIQUE INDEX idx_team_invites_discord_code
      ON team_invites(discord_code)
      WHERE discord_code IS NOT NULL;

    CREATE INDEX idx_team_invites_pending_discord_code
      ON team_invites(created_at)
      WHERE discord_code IS NULL AND active = true;
  `,
);
