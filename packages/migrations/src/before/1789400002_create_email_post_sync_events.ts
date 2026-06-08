import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS email_post_sync_events (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email_message_id  UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
          team_id           UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL CHECK (kind IN ('approval_request','post_summary','post_original')),
          attempts          INT NOT NULL DEFAULT 0,
          processed_at      TIMESTAMPTZ,
          error             TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (email_message_id, kind)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_post_sync_events_unprocessed
          ON email_post_sync_events (created_at)
          WHERE processed_at IS NULL
      `,
    ),
  ),
);
