import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Slice 3a of "Setup memberships" — the billing source of truth. `membership_plans` already
// carries a per-training price (Slice 1), but nothing recorded that a member ATTENDED a
// training, so nothing could be billed from it. This table is that record: `present` is the
// captain's stored yes/no for one member at one event, and `confirmed_at`/`confirmed_by` are
// who affirmed it and when. A later slice bills ONLY rows where `confirmed_at IS NOT NULL AND
// present` — never a live RSVP, never an unconfirmed pre-tick.
//
// No partial index here — every query in this slice is keyed by `event_id` and already served
// by the `UNIQUE (event_id, team_member_id)` constraint below. Add one later, next to the query
// that actually needs it.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS event_attendance (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      present        BOOLEAN NOT NULL,
      -- NULL = unconfirmed. Billing reads ONLY rows where this is set AND present.
      confirmed_at   TIMESTAMPTZ,
      confirmed_by   UUID REFERENCES team_members(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, team_member_id),
      -- One-directional ONLY. A two-sided (confirmed_at IS NULL) = (confirmed_by IS NULL)
      -- breaks the FK's ON DELETE SET NULL, which Postgres executes as an UPDATE that
      -- re-evaluates the CHECK and fails with an opaque 23514 (verified on PG17) the moment a
      -- confirming member is deleted. This form survives that delete and still keeps the half
      -- that matters: an unconfirmed row can never carry a confirmer.
      CHECK (confirmed_by IS NULL OR confirmed_at IS NOT NULL)
    )
  `,
);
