import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS email_attachments (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email_message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
          filename         TEXT NOT NULL,
          content_type     TEXT NOT NULL,
          size_bytes       INT NOT NULL,
          content          BYTEA NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_attachments_email_message_id
          ON email_attachments (email_message_id)
      `,
    ),
  ),
);
