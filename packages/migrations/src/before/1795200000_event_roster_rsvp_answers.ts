import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Which RSVP answers feed an event roster (auto-approve, approval requests, backfill). The default
// is exactly what the code hard-coded before this column existed: 'yes' and 'coming_later'. 'no'
// can never feed a roster, and an empty set would silently turn the feature off.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE event_rosters
      ADD COLUMN rsvp_answers text[] NOT NULL DEFAULT ARRAY['yes', 'coming_later']::text[],
      ADD CONSTRAINT event_rosters_rsvp_answers_check CHECK (
        cardinality(rsvp_answers) > 0
        AND rsvp_answers <@ ARRAY['yes', 'coming_later', 'maybe']::text[]
      )
  `;
});
