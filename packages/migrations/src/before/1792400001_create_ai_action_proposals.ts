import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The AI assistant's write path (plan `.work-plans/ai-app-interaction.md` §16): the model never
// writes. It PROPOSES, storing the action here, and the user confirms it through an endpoint that
// carries nothing but this row's opaque `id`. The action data never leaves the server, so there is
// nothing on the wire for a client to tamper with.
//
// Which side writes each column is the whole design, and it is not symmetric:
//
//   id           DB   — gen_random_uuid(); never derived from anything the model or client saw
//   team_id      app  — from ToolContext.teamId, NEVER from a tool argument
//   user_id      app  — ctx.membership.user_id; scopes the claim so a foreign id is a 404
//   action       app  — an AiActionName literal
//   payload      app  — the encoded tool args; read back with payload::text, never as jsonb
//   created_at   DB   — default
//   expires_at   DB   — now() + INTERVAL '15 minutes', written IN the INSERT statement. Absolute
//                       and on the DB clock: never a client- or model-supplied duration.
//   consumed_at  DB   — now() in the claim UPDATE. App code never sets it.
//
// `expires_at` and `consumed_at` being DB-written is what lets the confirm path enforce single-use
// AND expiry in one statement (`UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()
// RETURNING`), evaluated against the same `transaction_timestamp()` as the `SELECT ... FOR UPDATE`
// that precedes it in the same transaction. Two concurrent confirms therefore create exactly one
// event, and the loser is told "already confirmed" truthfully rather than as a guess.
//
// Both FKs CASCADE: a deleted team or user must not leave a confirmable write behind, and nothing
// in a row that lives fifteen minutes is worth preserving.
//
// No index beyond the PK, deliberately. The claim is `WHERE id = $1 AND team_id = $2 AND
// user_id = $3` — the PK resolves it and the other two are filters on that one row. The obvious
// `(expires_at) WHERE consumed_at IS NULL` index has no scanner until the expiry cron exists
// (deferred by §16); the cron's PR adds the index and the reaper together, or neither.
//
// The `action` CHECK is deliberate too: adding an action should cost a migration as well as a
// registry entry, so the database is the second half of "a new action is a compile error". The
// cost is one DROP CONSTRAINT / ADD CONSTRAINT in that action's own migration.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS ai_action_proposals (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action      TEXT        NOT NULL,
      payload     JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      CONSTRAINT ai_action_proposals_action_known CHECK (action IN ('create_event')),
      CONSTRAINT ai_action_proposals_ttl_positive CHECK (expires_at > created_at)
    )
  `,
);
