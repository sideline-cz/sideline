import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // 1. Add gender column
    Effect.tap(() => sql`ALTER TABLE age_threshold_rules ADD COLUMN gender TEXT`),

    // 2. Add CHECK constraint for gender values
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_gender_check CHECK (gender IS NULL OR gender IN ('male','female','other'))`,
    ),

    // 3. Delete pathological rows with no criteria at all, log warning if any removed
    Effect.tap(() =>
      sql<{ team_id: string }>`
        DELETE FROM age_threshold_rules
        WHERE min_age IS NULL AND max_age IS NULL
        RETURNING team_id
      `.pipe(
        Effect.flatMap((deleted) =>
          deleted.length > 0
            ? Effect.logWarning(
                `Migration 1747400000: deleted ${deleted.length} age_threshold_rules row(s) with no criteria (min_age=NULL, max_age=NULL). Affected team_ids: ${[...new Set(deleted.map((r) => r.team_id))].join(', ')}`,
              )
            : Effect.void,
        ),
      ),
    ),

    // 4. Add CHECK constraint ensuring at least one criterion is set
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_nonempty_criteria CHECK (min_age IS NOT NULL OR max_age IS NOT NULL OR gender IS NOT NULL)`,
    ),

    // 5. Drop old unique constraint (team_id, group_id)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules DROP CONSTRAINT age_threshold_rules_team_group_unique`,
    ),

    // 6. Add new composite unique constraint (team_id, group_id, min_age, max_age, gender) — NULLS NOT DISTINCT (PG15+)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_team_group_criteria_unique UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)`,
    ),
  ),
);
