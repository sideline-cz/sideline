import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Per-event-type overrides for the RSVP reminder lead time, keyed by `events.event_type`
// (training / match / tournament / meeting / social / other). A PARTIAL map: a type absent from
// it falls back to the scalar `rsvp_reminder_days_before`, which stays the team-wide default.
//
// Defaulting to an empty object is what makes this a no-op on deploy — every existing team keeps
// resolving every event type to the same scalar it used before.
//
// The CHECK only pins the TOP-LEVEL shape — it says nothing about the values. Key and range
// validation (0..14, known event types) lives in `TeamSettingsApi`, which is the trust boundary.
// Because neither constrains a value written by direct SQL, the reminder query gates its `::int`
// cast on `jsonb_typeof(...) = 'number'` rather than trusting this constraint: that query spans
// every team, so a raising cast there would stop reminders for all of them.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE team_settings
      ADD COLUMN IF NOT EXISTS rsvp_reminder_days_before_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
        CONSTRAINT team_settings_reminder_overrides_is_object
        CHECK (jsonb_typeof(rsvp_reminder_days_before_overrides) = 'object')
  `,
);
