import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Per-team dot colour for an activity type. A table, not a column: built-in types are one global
// row shared by every team, so a column would let one team recolour everyone's. No row = the web
// keeps deriving the colour from the type's position, so existing teams see no change.
// The CHECK list is character-identical to ActivityType.ActivityTypeColor. No person FK, so no
// GDPR export entry.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS activity_type_colors (
      team_id          UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      activity_type_id UUID NOT NULL REFERENCES activity_types(id) ON DELETE CASCADE,
      color            TEXT NOT NULL CHECK (color IN ('emerald','sky','amber','violet','rose',
                                                      'teal','orange','fuchsia')),
      PRIMARY KEY (team_id, activity_type_id)
    )
  `,
);
