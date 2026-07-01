import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // One active `/sudo` session per (team, discord user) — tracks the audit
    // message location + start time so leaving sudo (via button or re-running
    // /sudo) can find and close that message and compute the elapsed duration.
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS sudo_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          discord_user_id TEXT NOT NULL,
          system_channel_id TEXT NOT NULL,
          audit_message_id TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          UNIQUE (team_id, discord_user_id)
        )
      `,
    ),
  ),
);
