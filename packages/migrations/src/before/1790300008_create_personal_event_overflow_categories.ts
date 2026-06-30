import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS personal_event_overflow_categories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          discord_category_id TEXT,
          sequence INT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (team_id, sequence)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_event_overflow_categories_discord_category
          ON personal_event_overflow_categories (discord_category_id)
          WHERE discord_category_id IS NOT NULL
      `,
    ),
  ),
);
