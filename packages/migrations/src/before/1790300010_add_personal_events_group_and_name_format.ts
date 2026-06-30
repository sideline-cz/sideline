import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Optional group restriction: when set, only members of this group (and its
    // descendant groups) get a personal events channel; everyone else uses the
    // global events channel. NULL = all active members (default behaviour).
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS discord_personal_events_group_id UUID REFERENCES groups(id) ON DELETE SET NULL`,
    ),
    // Format template for generated personal events channel names.
    // Placeholders: {name} (member display name), {discord_id}.
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS discord_personal_events_channel_format TEXT NOT NULL DEFAULT 'events-{discord_id}'`,
    ),
  ),
);
