import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // email_forwarding_config — add 10 IMAP columns
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_enabled BOOLEAN NOT NULL DEFAULT false`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_host TEXT`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_port INTEGER`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_username TEXT`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_secret_encrypted TEXT`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_use_tls BOOLEAN NOT NULL DEFAULT true`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_folder TEXT`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_last_seen_uid INTEGER NOT NULL DEFAULT 0`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_uid_validity INTEGER`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS imap_last_synced_at TIMESTAMPTZ`,
    ),
    // Partial index for efficient poller scan
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_forwarding_imap_enabled
          ON email_forwarding_config (team_id)
          WHERE imap_enabled = true AND enabled = true AND imap_secret_encrypted IS NOT NULL
      `,
    ),
    // email_messages — add message_id column + unique partial index for dedup
    Effect.tap(() => sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS message_id TEXT`),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_email_messages_team_message_id
          ON email_messages (team_id, message_id)
          WHERE message_id IS NOT NULL
      `,
    ),
  ),
);
