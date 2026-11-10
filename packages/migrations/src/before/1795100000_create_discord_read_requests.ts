import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The AI assistant reads Discord messages live through this table. The server never calls the
// bot: it inserts a request row and polls it, the bot claims the row on its 1 s poll loop, reads
// Discord, and writes the answer back into the SAME row. Request and result share one row, so the
// result write IS the ack (`processed_at` and `result` set in one UPDATE ... WHERE processed_at IS
// NULL) and one DELETE removes both.
//
// Which side writes each column:
//
//   id             DB     — gen_random_uuid()
//   team_id        server — from ToolContext.teamId, NEVER from a tool argument
//   channel_id     server — from the resolved discord_channels mirror row, never a tool argument
//   since_at       server — now() - hours, computed on the DB clock in the INSERT
//   message_limit  server — the clamped tool limit
//   created_at     DB     — default
//   picked_at      server — set on the bot's GetUnprocessedRequests poll
//   processed_at   server — now(), set on the bot's SubmitResult
//   result         server — the bot's DiscordReadResult, set on SubmitResult
//
// No index beyond the PK, deliberately. The server deletes each row when it reads the result
// (read-once) or when its 15 s wait ends, and a cron deletes every row older than 5 minutes. The
// table holds a few rows at most, so the 1 s poll is a seq scan over almost nothing.
//
// GDPR decision: the table has NO foreign key to users or team_members. Message authors are
// stored as Discord display names inside result, not as a person FK, so the GDPR export manifest
// needs no entry. The content is still personal data (member messages). It is out of scope for
// Art. 15 export and for erasure because: (a) Discord, not Sideline, is the record holder —
// Sideline copies a window on request and keeps it for one chat turn; (b) the server deletes the
// row when it reads the result (normally under 15 s after insert); (c) the sweeper deletes every
// row older than 5 minutes, so an export or erasure run can at most miss content that is gone
// minutes later; (d) a team delete cascades. An export that lists transient cache rows would show
// "your data" that no longer exists.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS discord_read_requests (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id       UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      channel_id    TEXT        NOT NULL,
      since_at      TIMESTAMPTZ,
      message_limit INTEGER     NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      picked_at     TIMESTAMPTZ,
      processed_at  TIMESTAMPTZ,
      result        JSONB,
      CONSTRAINT discord_read_requests_limit_range CHECK (message_limit BETWEEN 1 AND 100),
      CONSTRAINT discord_read_requests_result_iff_processed
        CHECK ((processed_at IS NULL) = (result IS NULL))
    )
  `,
);
