import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * PR 4 of the all-day-Discord-start-time plan (§13.6, §4.8.1, §15.1).
 *
 * Ships the two deferred-action stamp columns plus the new post-time column,
 * all three needed by PR 4's server changes:
 *
 * - `events.missed_rsvp_counted_at` — arms/disarms the deferred missed-RSVP
 *   sweep (§4.8). `NULL` means "armed" (still to be counted); a non-`NULL`
 *   value means "already counted" (or, for pre-existing rows, "disarmed by
 *   this migration's backfill" — see below).
 * - `events.all_day_post_sent_at` — the same `*_sent_at TIMESTAMPTZ` idiom
 *   (`reminder_sent_at`, `claim_request_sent_at`, `coaching_status_sent_at`),
 *   third instance, gating the deferred team-local-morning "Dnes" post (§15).
 * - `team_settings.all_day_post_time` — the team-local `HH:MM` trigger for
 *   that post, shaped exactly like `rsvp_reminder_time`
 *   (`1745800000_rsvp_reminder_v2.ts:12`), defaulting to `08:00`.
 *
 * **Why the backfill for BOTH new event columns must be ONE unconditional
 * `UPDATE`, not two, and not scoped by `WHERE`:**
 *
 * 1. Migrations run at new-server boot, inside the app's own startup effect
 *    (`applications/server/src/run.ts:80,260`), while an OLD container may
 *    still be serving and its cron still ticking. An all-day event that flips
 *    in that window is processed by OLD code and left with a `NULL` stamp —
 *    then swept again by NEW code once this migration's columns exist. A
 *    scoped backfill (e.g. `WHERE status <> 'active'`) leaves every FUTURE
 *    `active` event `NULL` and armed, which is exactly the sequence that
 *    mass-increments missed-RSVP counters and mass-posts "Dnes:" for up to a
 *    week of historical all-day events on the first cron cycle after deploy.
 * 2. A revert leaves the columns behind (never dropped, per the established
 *    `*_sent_at` rollback story) — restored old code increments/flips and
 *    leaves the stamp `NULL`; a later re-deploy would sweep those rows again
 *    if the backfill were not unconditional and already applied.
 *
 * Backfilling to `COALESCE(updated_at, start_at)` disarms every pre-existing
 * row regardless of `status`, `all_day`, or date. Only rows written or flipped
 * by NEW code (which stamps `missed_rsvp_counted_at`/`all_day_post_sent_at`
 * via the `CASE WHEN all_day THEN NULL ELSE now() END` in the `start`
 * statement — `EventsRepository.ts`) can ever be `NULL` again, and those are
 * the only rows the two deferred sweeps below are meant to see.
 *
 * `events.updated_at` is `TIMESTAMPTZ NOT NULL DEFAULT now()`
 * (`1741400000_create_events.ts:22`), so the `COALESCE(updated_at,
 * start_at)` is belt-and-braces, not a real fallback need.
 *
 * Kept as its own migration file, separate from `1791300000` (the anchored
 * flag) and `1791400000` (the data move) — the three have different rollback
 * stories and different release-scheduling constraints (§13.6's table).
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS missed_rsvp_counted_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS all_day_post_sent_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS all_day_post_time TIME NOT NULL DEFAULT '08:00'
      `,
    ),
    // One unconditional backfill covering both stamps in the same statement —
    // see the module doc comment above for why this MUST NOT be split into
    // two statements or scoped with a WHERE clause.
    Effect.tap(
      () => sql`
        UPDATE events
        SET missed_rsvp_counted_at = COALESCE(updated_at, start_at),
            all_day_post_sent_at   = COALESCE(updated_at, start_at)
      `,
    ),
  ),
);
