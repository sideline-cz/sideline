import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS event_join_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
          message TEXT,
          decided_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
          decided_at TIMESTAMPTZ,
          discord_channel_id TEXT,
          discord_message_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (event_id, team_member_id)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_event_join_requests_event_status
          ON event_join_requests (event_id, status)
      `,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events DROP CONSTRAINT IF EXISTS event_sync_events_event_type_check`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events ADD CONSTRAINT event_sync_events_event_type_check CHECK (event_type IN ('event_created', 'event_updated', 'event_cancelled', 'rsvp_reminder', 'event_started', 'training_claim_request', 'training_claim_update', 'unclaimed_training_reminder', 'coaching_status', 'tournament_join_request', 'tournament_attendance_update'))`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS join_request_id UUID`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS join_request_message_id TEXT`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS requester_display_name TEXT`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS request_message TEXT`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS decided_by_display_name TEXT`,
    ),
  ),
);
