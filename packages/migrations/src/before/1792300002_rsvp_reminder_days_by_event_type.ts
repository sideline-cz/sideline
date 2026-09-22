import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Per-event-type overrides for the RSVP reminder lead time, keyed by `events.event_type`
// (training / match / tournament / meeting / social / other). A PARTIAL map: a type absent from
// it falls back to the scalar `rsvp_reminder_days_before`, which stays the team-wide default.
//
// Defaulting to an empty object is what makes this a no-op on deploy — every existing team keeps
// resolving every event type to the same scalar it used before.
//
// The CHECK only pins the top-level shape. Key and range validation (0..14, known event types)
// lives in `TeamSettingsApi`, which is the trust boundary; the constraint exists so a malformed
// write can never make the `->>` lookup in the reminder query misbehave.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE team_settings
      ADD COLUMN IF NOT EXISTS rsvp_reminder_days_before_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
        CONSTRAINT team_settings_reminder_overrides_is_object
        CHECK (jsonb_typeof(rsvp_reminder_days_before_overrides) = 'object')
  `,
);
