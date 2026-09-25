import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Opt-in sibling of `auto_match_enabled`: every newly POLLED outgoing movement becomes an
// expense automatically. Defaults to `false`, so no existing club's books change on deploy.
//
// It lives on `bank_sync_config` rather than `team_settings` because it is bank-sync behaviour,
// the poller already holds this row, and it belongs next to the flag it mirrors. Read in exactly
// one place (`BankSyncPoller.autoCreateExpenses`), which considers ONLY movements first ingested
// during the cycle that is running. That matters twice over: the backfill path never reaches it,
// AND the poller's own rolling >=14-day window would otherwise re-expense a fortnight of history
// the moment this is switched on.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE bank_sync_config
      ADD COLUMN IF NOT EXISTS auto_create_expenses BOOLEAN NOT NULL DEFAULT false
  `,
);
