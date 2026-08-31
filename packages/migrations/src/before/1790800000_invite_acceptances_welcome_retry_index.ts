import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// PR-3 (Discord onboarding fix), CC-0 rule 2: `findPending`'s WHERE clause now re-opens a
// `welcome_channel_missing` row once `teams.welcome_channel_id` becomes non-null:
//   AND (ia.discord_code_error_code IS NULL
//        OR (ia.discord_code_error_code = 'welcome_channel_missing' AND t.welcome_channel_id IS NOT NULL))
// The existing `idx_invite_acceptances_pending` partial index only covers the left side of the
// OR (`discord_code_error_code IS NULL`), so the added branch would force a sequential scan.
// Adding a second partial index for the `welcome_channel_missing` branch lets Postgres BitmapOr
// the two together, matching the query's WHERE shape.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE INDEX IF NOT EXISTS idx_invite_acceptances_welcome_retry
      ON invite_acceptances(created_at)
      WHERE discord_code IS NULL AND discord_code_error_code = 'welcome_channel_missing'
  `,
);
