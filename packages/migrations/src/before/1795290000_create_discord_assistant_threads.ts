import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// A Discord thread opened with `/assistant`. The bot routes a message in a thread to the AI
// assistant only when the thread has a row here and the author is the row's user. The
// conversation itself is not stored: the bot rebuilds it from the thread's own messages on each
// turn, so this row only answers "is this an assistant thread, and whose?".
//
// GDPR: `user_id` is a person FK — recorded in the server's EXPORT_MANIFEST (excluded from export,
// deleted on erasure). Deleting the user or the team removes the row.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS discord_assistant_threads (
      thread_id  TEXT        PRIMARY KEY,
      team_id    UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
);
