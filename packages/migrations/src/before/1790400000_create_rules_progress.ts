import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * `rules_attempts` has NO `team_id` column. Attempts are user-scoped and must
 * survive joining or leaving a team — a nullable `team_id` already means
 * "global/built-in row, immutable from the API" for team-scoped resources
 * (see `applications/server/AGENTS.md` → "Team-Scoped Resources With Global
 * Rows"), so reusing NULL for "practised outside a team" would collide with
 * that established reading. The future team leaderboard joins
 * `team_members` on `(team_id, user_id) AND tm.active = true` at read time,
 * the same way every other ranking query in this repo starts.
 *
 * `mode` is TEXT + a CHECK constraint, never `CREATE TYPE` (there are zero
 * `CREATE TYPE` uses in this repo). Postgres names the constraint
 * `rules_attempts_mode_check` by default. Adding a third `mode` value later
 * is a two-release change: widen the CHECK to a permissive superset first
 * (`DROP CONSTRAINT IF EXISTS rules_attempts_mode_check` then re-add with the
 * new value included) and only start writing it once every deployed
 * consumer tolerates it — see `packages/migrations/AGENTS.md` →
 * "Rolling-deploy-safe enum widening" and
 * `1790300016_rename_rsvp_maybe_to_coming_later.ts`.
 *
 * `score`/`total` are plain `INT`, computed server-side by `scoreAttempt`
 * from `@sideline/rules` in the follow-up PR — see `packages/rules/AGENTS.md`
 * ("scoring is shared logic, NOT a trust boundary").
 *
 * Mastery is computed on read from `MAX(finished_at)` per correct scenario
 * result (see `@sideline/rules`'s `engine/mastery.ts`), so there is no
 * materialised score column and no cron.
 *
 * Indexes are deliberately minimal. That read drives off `user_id`
 * (`idx_rules_attempts_user`) and then reaches results by `attempt_id`, which
 * the `(attempt_id, scenario_id)` primary key already covers — including for
 * the Phase 3 team leaderboard, which is the same aggregation run per member.
 * An earlier draft also carried a partial index on
 * `rules_scenario_results (scenario_id) WHERE correct`; it was dropped because
 * it serves a different shape of query (per-scenario stats *across* users,
 * e.g. "which situations does everyone get wrong") and no such query exists
 * yet. Add it with the query that needs it, and measure first — adding an
 * index later is a purely additive migration.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE rules_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('practice', 'exam')),
        packages INT[] NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        score INT NOT NULL DEFAULT 0 CHECK (score >= 0),
        total INT NOT NULL DEFAULT 0 CHECK (total >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_rules_attempts_user ON rules_attempts (user_id, finished_at DESC, id DESC)`,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE rules_scenario_results (
        attempt_id UUID NOT NULL REFERENCES rules_attempts(id) ON DELETE CASCADE,
        scenario_id TEXT NOT NULL,
        correct BOOLEAN NOT NULL,
        steps JSONB NOT NULL,
        PRIMARY KEY (attempt_id, scenario_id)
      )
    `,
    ),
  ),
);
