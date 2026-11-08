import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// activity_logs.season_id: the season a log belongs to, set by a trigger at write time and stable
// after that. NULL = "Earlier" (before the first season or in a gap between seasons).
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Fail fast instead of blocking boot behind the previous container's activity_logs queries
    // during the blue-green window (packages/migrations/AGENTS.md, rule 1).
    Effect.tap(() => sql`SET LOCAL lock_timeout = '5s'`),
    // ON DELETE SET NULL, not RESTRICT (Cascade Discipline rule 3): the app never deletes seasons,
    // but team deletion cascades seasons and test fixtures delete them. A season delete then moves
    // its logs to Earlier; it never blocks the delete and never loses a log.
    Effect.tap(
      () => sql`
        ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS season_id UUID
          REFERENCES seasons(id) ON DELETE SET NULL
      `,
    ),
    // The ONE rule for "which season covers this moment". It compares Prague calendar dates, not
    // instants: a dated manual log is stored at Prague noon (ActivityLogDate.ts), an undated one at
    // now(), and starts_at / expires_at are arbitrary instants (seed season = team creation instant,
    // backfilled expires_at = 12:00 UTC). Comparing dates maps one Prague day to exactly one season,
    // whatever the input path. A season covers its start day in full; its expiry day belongs to the
    // next period. ORDER BY starts_at is total because of UNIQUE (team_id, starts_at), so LIMIT 1
    // is deterministic; two seasons that start on one Prague day: the later one wins.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION season_at(p_team_id UUID, p_at TIMESTAMPTZ)
        RETURNS UUID LANGUAGE sql STABLE AS $$
          SELECT CASE
                   WHEN s.expires_at IS NULL
                     OR (p_at AT TIME ZONE 'Europe/Prague')::date
                        < (s.expires_at AT TIME ZONE 'Europe/Prague')::date
                   THEN s.id END
          FROM seasons s
          WHERE s.team_id = p_team_id
            AND (s.starts_at AT TIME ZONE 'Europe/Prague')::date
                <= (p_at AT TIME ZONE 'Europe/Prague')::date
          ORDER BY s.starts_at DESC
          LIMIT 1
        $$
      `,
    ),
    // Differs from governing_season_id on purpose: that one may return a future season (plan
    // selection). This one is the season of today, by the same rule the trigger uses.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION current_season_id(p_team_id UUID)
        RETURNS UUID LANGUAGE sql STABLE AS $$
          SELECT season_at(p_team_id, now())
        $$
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION season_for_activity_log(p_team_member_id UUID, p_logged_at TIMESTAMPTZ)
        RETURNS UUID LANGUAGE sql STABLE AS $$
          SELECT season_at(
            (SELECT tm.team_id FROM team_members tm WHERE tm.id = p_team_member_id),
            p_logged_at
          )
        $$
      `,
    ),
    // The logged_at guard is needed: ActivityLogsRepository.updateQuery always writes
    // logged_at = COALESCE(...), so a note-only edit would otherwise re-derive the season against
    // today's season dates and break "stable at write". The DB owns the column: a supplied
    // season_id on INSERT is overwritten. No trigger on seasons rewrites logs; that is intended.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION set_activity_log_season() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'UPDATE' AND NEW.logged_at IS NOT DISTINCT FROM OLD.logged_at THEN
            RETURN NEW;
          END IF;
          NEW.season_id := season_for_activity_log(NEW.team_member_id, NEW.logged_at);
          RETURN NEW;
        END $$
      `,
    ),
    // Trigger BEFORE backfill: CREATE TRIGGER's ShareRowExclusiveLock blocks the old server's
    // INSERTs until COMMIT, so no row can slip between the two statements.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER activity_logs_set_season_trg
          BEFORE INSERT OR UPDATE OF logged_at ON activity_logs
          FOR EACH ROW EXECUTE FUNCTION set_activity_log_season()
      `,
    ),
    // UPDATE only, and only rows that change: nearly all old logs predate every season and stay
    // NULL untouched (less bloat, shorter lock). logged_at is not in the SET list, so the trigger
    // does not fire. A re-run is a no-op.
    Effect.tap(
      () => sql`
        UPDATE activity_logs
        SET season_id = season_for_activity_log(team_member_id, logged_at)
        WHERE season_id IS NULL
          AND season_for_activity_log(team_member_id, logged_at) IS NOT NULL
      `,
    ),
    // Serves listLogs, stats and the leaderboard join; B-tree indexes NULL, so the Earlier scope
    // (season_id IS NULL) uses it too. idx_activity_logs_team_member_id is now a prefix duplicate;
    // drop it in a later PR.
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_activity_logs_member_season
          ON activity_logs (team_member_id, season_id, logged_at DESC)
      `,
    ),
  ),
);
