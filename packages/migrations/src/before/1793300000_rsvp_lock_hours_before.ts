import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Makes the RSVP deadline configurable. Until now it was hardcoded to the event's start instant
// (`eventAcceptsRsvp`); these two columns move it N hours earlier.
//
// `rsvp_lock_hours_before` is the team-wide value and is NULLABLE with NO DEFAULT on purpose:
// NULL means "no early lock", which is exactly the current behaviour, so every existing row is
// already correct and the deploy is a no-op. No backfill.
//
// `rsvp_lock_hours_before_overrides` is the per-event-type map, keyed by `events.event_type`,
// mirroring `rsvp_reminder_days_before_overrides` (1792300002). PARTIAL on purpose, with three
// reachable states per key: absent = inherit the scalar above, JSON `null` = no early lock for
// that type, `0` = lock exactly at start.
//
// `IS NULL OR` on the range CHECK is redundant to Postgres (a NULL comparison yields NULL, which
// passes) but states the intent.
//
// As with the reminder overrides, the JSONB CHECK only pins the TOP-LEVEL shape. Key and range
// validation (0..336, known event types) lives in `TeamSettingsApi`, the trust boundary, so any
// SQL reading a value out of this map must gate its `::int` cast on `jsonb_typeof(...)`.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS rsvp_lock_hours_before INT
            CONSTRAINT team_settings_rsvp_lock_hours_before_range
            CHECK (rsvp_lock_hours_before IS NULL OR rsvp_lock_hours_before BETWEEN 0 AND 336)
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS rsvp_lock_hours_before_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
            CONSTRAINT team_settings_rsvp_lock_overrides_is_object
            CHECK (jsonb_typeof(rsvp_lock_hours_before_overrides) = 'object')
      `,
    ),
  ),
);
