import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The honest "when did we actually receive this token" stamp, written by the DB's own clock in
// `BankSyncConfigRepository`'s upsert whenever a new encrypted token is stored — and only then.
// Why this column and not `fio_token_created_at`, and how far a reader may trust it: see
// `BankSyncConfig.fio_token_saved_at`.
//
// NOTHING READS THIS COLUMN YET. The `activating` verdict and the D11 status ladder are the
// deliberately-deferred follow-up this migration unblocks.
//
// No backfill, on purpose. The `*_sent_at` rule in `AGENTS.md` ("Backfill Idempotency Markers on
// Add") does not apply — no cron reads this column — and its own reasoning argues against a
// backfill here, because the polarity is inverted. For a `*_sent_at` marker `NULL` is the
// dangerous value that makes a cron fire; here `NULL` is the safe value meaning "nothing is
// currently activating". The blast-equivalent would be caused BY backfilling: `now()` would make
// every already-working production token look freshly-saved and rank `activating` the moment the
// follow-up ships, and `fio_token_created_at` would import the exact user-declared date this
// column exists to replace.
//
// Ship this alone, not batched with the deferred `1792100000_series_time_is_team_local.ts`:
// `Migrator.js` runs a whole pending batch in ONE transaction, so this `ALTER`'s
// `ACCESS EXCLUSIVE` lock would be held until that migration's full-table `UPDATE` commits — and
// `MigrateBefore` runs inside server boot, so the container would not accept traffic until then.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE bank_sync_config
      ADD COLUMN IF NOT EXISTS fio_token_saved_at TIMESTAMPTZ
  `,
);
