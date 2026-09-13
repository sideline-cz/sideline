import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * `event_series.times_are_team_local` asserts, per row, what dialect
 * `start_time`/`end_time` are stored in: `TRUE` means the value is a WALL
 * CLOCK in the team's own `team_settings.timezone` (the corrected, post-#650
 * semantics); `FALSE` means the value is a UTC time-of-day, resolved to an
 * instant the same way `EventHorizonCron` always used to —
 * `` `${dateStr}T${start_time}Z` `` — before that bug fix existed. It
 * defaults `FALSE` so every pre-existing row, and every row written by a
 * writer that does not yet know this column exists, keeps its historical
 * (UTC) meaning rather than being silently reinterpreted.
 *
 * ## Split from the conversion, deliberately, across two releases
 *
 * This migration was originally merged together with the conversion
 * (rewriting `start_time`/`end_time` themselves, and re-anchoring already-
 * materialized `events` rows) as a single file. That is unsafe for a rolling,
 * blue-green deploy: MajNet keeps the previous container alive throughout a
 * rollout (see `docs/deployment.md` §5.4), so for some window BOTH the new
 * and the immediately-previous server image are reading and writing
 * `event_series` concurrently. A previous-image server has no idea the
 * column exists, let alone that a `TRUE` row now means "wall clock" — it
 * would go on treating every row's `start_time` as UTC, corrupting occurrence
 * times for any series the conversion had already touched.
 *
 * So the column and the conversion are two separate migrations. THIS one
 * (`1791700000`) ONLY adds the column, defaulted `FALSE` — a pure schema
 * no-op, safe for the previous image to run alongside, because nothing yet
 * reads or writes it as `TRUE`. The conversion itself is deferred to
 * `1791800000`, which ships in the NEXT release, once the server image that
 * is about to become "the previous one" during that rollout already knows to
 * read this flag on every branch that resolves a series time to an instant
 * (`applications/server/src/utils/seriesTimeDialect.ts`). By the time
 * `1791800000` runs and starts marking rows `TRUE`, every server capable of
 * being alive in the same deploy window already understands what `TRUE`
 * means.
 *
 * `DEFAULT FALSE` is load-bearing for this same reason and must not be
 * flipped in this migration: a series created by a still-running previous-
 * release server during THIS release's rollout writes no opinion about the
 * column at all, and the column default is what correctly marks that row
 * `FALSE` — UTC-semantics, exactly what that server actually wrote.
 *
 * ## Release N CAN write `TRUE` on create
 *
 * This migration converts nothing, but that does NOT mean "every row is `FALSE` until
 * `1791800000`". On create there is no existing row to assert a dialect against, so
 * `event-series.ts`'s create handler writes `payload.timesAreTeamLocal` explicitly — naming
 * this column for the first time this release (see
 * `EventSeriesRepository.insertEventSeries`) — and a payload declaring `true` therefore
 * produces a genuine `TRUE` row holding wall-clock times. Do not weaken that to a hardcoded
 * `FALSE` with a rejection on mismatch: the property `1791800000`'s Statement A guard
 * actually needs is "every `FALSE` row is genuinely UTC-semantics", NOT "every row is
 * `FALSE`", and explicit create-time marking is what keeps the former true. `DEFAULT FALSE`
 * above remains correct and load-bearing for writers that omit the flag entirely
 * (`v0.37.2`); it is simply no longer the only way a row gets marked.
 *
 * Residual: during THIS release's own rollout, an old `v0.49.3` server (which knows nothing
 * of `times_are_team_local` and always treats `start_time` as UTC) would misread a `TRUE` row
 * written by the new server. In practice this is unreachable during a normal rollout — no
 * deployed client sends `timesAreTeamLocal: true` yet (`v0.37.2` does not know the field) —
 * so the only way to hit it is a hand-crafted API call inside that specific window.
 *
 * ## `IF NOT EXISTS`
 *
 * This statement is a verbatim lift of the `ALTER TABLE` from the withdrawn,
 * merged migration (previously id `1791600000`). The `testing` environment
 * already ran that file and therefore already has this column — `IF NOT
 * EXISTS` is what makes this migration a genuine no-op there rather than an
 * "already exists" error, while still applying cleanly (adding the column)
 * everywhere else that has not run it.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE event_series
          ADD COLUMN IF NOT EXISTS times_are_team_local BOOLEAN NOT NULL DEFAULT FALSE
      `,
    ),
  ),
);
