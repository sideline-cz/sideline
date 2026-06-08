import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS email_messages (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id                  UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          status                   TEXT NOT NULL DEFAULT 'received'
                                   CHECK (status IN ('received','summarizing','pending_approval','approved','send_original','rejected','posted_summary','posted_original','failed')),
          from_address             TEXT NOT NULL,
          subject                  TEXT NOT NULL,
          body                     TEXT NOT NULL,
          summary                  TEXT,
          summarize_attempts       INT NOT NULL DEFAULT 0,
          last_error               TEXT,
          approval_request_message_id TEXT,
          approved_by              TEXT,
          rejected_by              TEXT,
          posted_channel_id        TEXT,
          received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_messages_status_received
          ON email_messages (received_at)
          WHERE status = 'received'
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_messages_team_id
          ON email_messages (team_id)
      `,
    ),
  ),
);
