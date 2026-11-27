import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// A coach can set another member's RSVP.
//
// `event_rsvps.set_by` is the coach who set it; NULL when the member answered themselves (every
// self-answer resets it). GDPR: a person FK — recorded in the server's EXPORT_MANIFEST.
//
// Both CHECK widenings are supersets, so every existing row stays valid.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      ALTER TABLE event_rsvps
        ADD COLUMN IF NOT EXISTS set_by UUID REFERENCES team_members(id) ON DELETE SET NULL
    `,
    ),
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
          'event_roster_thread_delete', 'teams_generated', 'event_channel_moved',
          'rsvp_set_by_coach'
        ))
    `,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals DROP CONSTRAINT IF EXISTS ai_action_proposals_action_known`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals ADD CONSTRAINT ai_action_proposals_action_known CHECK (action IN ('create_event', 'create_discord_channel', 'set_discord_channel_access', 'archive_discord_channel', 'update_event', 'cancel_event', 'mark_attendance', 'set_my_rsvp', 'set_member_rsvp', 'create_group', 'add_group_member', 'remove_group_member', 'create_roster', 'add_roster_member', 'remove_roster_member', 'record_payment', 'create_expense', 'assign_membership_plan'))`,
    ),
  ),
);
