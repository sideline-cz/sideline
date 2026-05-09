import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE team_invites
      ADD COLUMN group_id UUID REFERENCES groups(id) ON DELETE SET NULL;

    CREATE INDEX idx_team_invites_group ON team_invites(group_id);

    ALTER TABLE teams
      ADD COLUMN welcome_channel_id      TEXT,
      ADD COLUMN system_log_channel_id   TEXT,
      ADD COLUMN welcome_message_template TEXT;
  `,
);
