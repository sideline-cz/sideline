import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // The channel-name format applied when a member's personal channel was last
    // (re)named. When it differs from the team's current format, the bot renames
    // the channel. NULL on rows created before this column existed → treated as
    // drifted, so they get renamed to the current format on the next poll.
    Effect.tap(
      () =>
        sql`ALTER TABLE personal_event_channels ADD COLUMN IF NOT EXISTS applied_channel_format TEXT`,
    ),
  ),
);
