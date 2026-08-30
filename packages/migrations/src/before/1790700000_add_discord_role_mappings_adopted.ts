import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// PR-6 blocker 2 fix: `discord_role_mappings` previously carried no provenance, so
// `handleDeleted`/`handleUnassigned` in the bot could not tell an adopted (pre-existing,
// human-managed) Discord role from one Sideline itself created. Deleting/stripping an adopted
// role destroys something Sideline never made. `adopted` records which mappings came from the
// adoption path (ensureMapping's tier 2) so the bot can refuse to delete the underlying Discord
// role for those rows — see `applications/bot/src/rcp/role/handleDeleted.ts`.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE discord_role_mappings ADD COLUMN IF NOT EXISTS adopted BOOLEAN NOT NULL DEFAULT false
  `,
);
