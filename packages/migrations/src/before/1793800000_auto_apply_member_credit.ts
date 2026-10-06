import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * "A member's credit should be consumed against what they owe without a treasurer clicking
 * Settle" — the schema half. ONE column on `team_settings`.
 *
 * NOT on `bank_sync_config`, where `auto_credit_enabled` and `auto_create_expenses` live.
 * Credit arrives by treasurer deposit as well as by bank transfer, so hanging this off the Fio
 * config would make it unreachable for a club that never connected a bank yet still holds
 * member credit. The *default* follows that precedent exactly though: false, so an existing
 * club's books do not change under it. This path writes `payments` rows, so it is at least as
 * consequential as either of them.
 *
 * The column is a NULLABLE USER ID, not a boolean, and it does BOTH jobs: NULL is off, non-NULL
 * is on AND names the user every auto-applied `payments` row is recorded under. A separate
 * boolean would be redundant state two writers could disagree about.
 *
 * It needs to name a user because `payments.recorded_by_user_id` is NOT NULL and a cron has no
 * authenticated caller of its own -- the same bind `bank_sync_config.configured_by_user_id`
 * solves for the matcher's auto-credit path. The API projects it to and from a plain
 * `autoApplyCreditEnabled` BOOLEAN (true -> the caller who flipped it, false -> NULL), so the
 * web form plumbs a primitive, `useCardForm` stays happy, and a UUID never reaches the client.
 *
 * ON DELETE SET NULL, not RESTRICT: a departing admin must not pin a team's settings row. The
 * consequence is deliberate and is the reason the two jobs share one column -- deleting that
 * user turns the feature OFF for the team rather than leaving it on with nobody to attribute
 * the money to. It stays off until someone re-saves the setting.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS auto_apply_credit_by_user_id UUID
            REFERENCES users(id) ON DELETE SET NULL
      `,
    ),
  ),
);
