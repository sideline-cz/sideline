import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// ponytail: invoice bytes live in Postgres BYTEA, same as email_attachments. Ceiling is DB size
// and backup/restore time — at ~5 MB a file this is fine for club-sized teams; move to object
// storage (S3-compatible) with a key column here if the table ever outgrows the backup window.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS expense_attachments (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          expense_id          UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
          filename            TEXT NOT NULL,
          content_type        TEXT NOT NULL,
          size_bytes          INT NOT NULL,
          content             BYTEA NOT NULL,
          uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_expense_attachments_expense_id
          ON expense_attachments (expense_id)
      `,
    ),
  ),
);
