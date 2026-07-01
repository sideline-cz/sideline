import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      ALTER TABLE event_sync_events
        DROP CONSTRAINT IF EXISTS event_sync_events_event_type_check
    `,
    ),
    Effect.tap(
      () => sql`
      ALTER TABLE event_sync_events
        ADD CONSTRAINT event_sync_events_event_type_check
        CHECK (event_type IN (
          'event_created', 'event_updated', 'event_cancelled', 'rsvp_reminder',
          'event_started', 'training_claim_request', 'training_claim_update',
          'unclaimed_training_reminder', 'coaching_status',
          'event_roster_approval_request', 'event_roster_approval_cancel',
          'event_roster_thread_delete', 'teams_generated', 'event_channel_moved'
        ))
    `,
    ),
  ),
);
