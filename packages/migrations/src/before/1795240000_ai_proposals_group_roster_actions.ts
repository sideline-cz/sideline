import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The AI assistant can now propose group and roster changes. Superset widening of the action
// CHECK from 1795230000: every existing row stays valid.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals DROP CONSTRAINT IF EXISTS ai_action_proposals_action_known`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals ADD CONSTRAINT ai_action_proposals_action_known CHECK (action IN ('create_event', 'create_discord_channel', 'set_discord_channel_access', 'archive_discord_channel', 'update_event', 'cancel_event', 'mark_attendance', 'set_my_rsvp', 'create_group', 'add_group_member', 'remove_group_member', 'create_roster', 'add_roster_member', 'remove_roster_member'))`,
    ),
  ),
);
