import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // 1. Add claim_request_days_before to team_settings
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS claim_request_days_before INT NOT NULL DEFAULT 3`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings DROP CONSTRAINT IF EXISTS team_settings_claim_request_days_before_check`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings ADD CONSTRAINT team_settings_claim_request_days_before_check CHECK (claim_request_days_before >= 0)`,
    ),

    // 2. Add new columns to events
    Effect.tap(
      () => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS claim_request_sent_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS coaching_status_sent_at TIMESTAMPTZ`,
    ),
    Effect.tap(() => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS claim_thread_id TEXT`),

    // 2b. Backfill existing trainings so the new crons skip them on first deploy
    Effect.tap(
      () =>
        sql`UPDATE events SET claim_request_sent_at = now() WHERE event_type = 'training' AND claim_request_sent_at IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`UPDATE events SET coaching_status_sent_at = now() WHERE event_type = 'training' AND coaching_status_sent_at IS NULL`,
    ),

    // 3. Update event_sync_events_event_type_check constraint to add coaching_status
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events DROP CONSTRAINT IF EXISTS event_sync_events_event_type_check`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events ADD CONSTRAINT event_sync_events_event_type_check CHECK (event_type IN ('event_created', 'event_updated', 'event_cancelled', 'rsvp_reminder', 'event_started', 'training_claim_request', 'training_claim_update', 'unclaimed_training_reminder', 'coaching_status'))`,
    ),

    // 4. Partial indexes for cron queries
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_events_claim_request_pending ON events (team_id, start_at) WHERE event_type = 'training' AND status = 'active' AND claim_request_sent_at IS NULL`,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_events_coaching_status_pending ON events (team_id, start_at) WHERE event_type = 'training' AND status = 'active' AND coaching_status_sent_at IS NULL AND claimed_by IS NOT NULL`,
    ),
  ),
);
