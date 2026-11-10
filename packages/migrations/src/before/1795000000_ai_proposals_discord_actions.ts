import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The AI assistant can now propose three Discord channel actions. Superset widening of the
// action CHECK from 1792400001: every existing row stays valid, so no row repair is needed.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals DROP CONSTRAINT IF EXISTS ai_action_proposals_action_known`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE ai_action_proposals ADD CONSTRAINT ai_action_proposals_action_known CHECK (action IN ('create_event', 'create_discord_channel', 'set_discord_channel_access', 'archive_discord_channel'))`,
    ),
  ),
);
