import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Retention for forwarded email.
 *
 * `email_messages.body` holds the full text of every email sent to a team's
 * connected mailbox, and `email_attachments.content` holds the raw bytes of
 * every attachment. Both were kept forever — `docs/database.md` recorded that
 * as a known V1 limitation, and the published privacy policy says so out loud.
 *
 * **The reason this matters more than the other tables: nobody who wrote those
 * emails signed up for Sideline.** A league, a venue, a parent — they have no
 * account, gave no consent, and have no way to ask for deletion. Every other
 * table in this schema holds data from someone who chose to be here.
 *
 * `purged_at` is what makes the purge idempotent and observable. Nulling
 * `body` alone would leave no way to tell "purged" from "arrived empty", so a
 * re-run would keep reprocessing the same rows and nobody could answer "was
 * this deleted, or did it never exist?".
 *
 * The body is emptied rather than the row deleted: `summary` is what actually
 * got posted to Discord and is the part anyone ever looks back at, and keeping
 * from/subject/status leaves an answer to "why did the bot post this?" long
 * after the source text is gone. Attachments are deleted outright — they are
 * the bulk and the highest-risk content, and nothing downstream reads them
 * once a message has been posted.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE email_messages
          ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ
      `,
    ),
    // Partial index matching the purge query exactly: only unpurged rows are
    // ever candidates, and that set shrinks to near-nothing once the job has
    // run once, so the index stays tiny however much mail accumulates.
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_email_messages_purgeable
          ON email_messages (received_at)
          WHERE purged_at IS NULL
      `,
    ),
  ),
);
