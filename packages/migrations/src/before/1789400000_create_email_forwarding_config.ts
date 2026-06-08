import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS email_forwarding_config (
          team_id       UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          enabled       BOOLEAN NOT NULL DEFAULT false,
          target_channel_id TEXT NOT NULL DEFAULT '',
          coach_channel_id  TEXT NOT NULL DEFAULT '',
          monitored_addresses TEXT[] NOT NULL DEFAULT '{}',
          inbound_token TEXT NOT NULL UNIQUE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    // Note: no explicit index on inbound_token — the UNIQUE constraint already creates one.
  ),
);
