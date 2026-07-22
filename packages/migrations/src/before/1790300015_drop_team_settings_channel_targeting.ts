import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Release B of the channel-by-type removal (expand/contract): the code surface
// of these six per-event-type channel columns was removed in Release A
// (#541); no deployed code references them anymore, so the drop is safe under
// rolling replacement. discord_channel_late_rsvp and discord_events_channel_id
// are separate features and stay.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_training`),
    Effect.tap(() => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_match`),
    Effect.tap(
      () => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_tournament`,
    ),
    Effect.tap(() => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_meeting`),
    Effect.tap(() => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_social`),
    Effect.tap(() => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS discord_channel_other`),
  ),
);
