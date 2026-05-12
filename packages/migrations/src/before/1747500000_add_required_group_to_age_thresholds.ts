import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // 1. Add required_group_id column (nullable FK to groups)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD COLUMN required_group_id UUID REFERENCES groups(id) ON DELETE CASCADE`,
    ),

    // 2. Add CHECK constraint preventing a rule from requiring its own target group
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_required_not_self CHECK (required_group_id IS NULL OR required_group_id <> group_id)`,
    ),

    // 3. Drop old nonempty_criteria constraint (did not include required_group_id)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules DROP CONSTRAINT age_threshold_rules_nonempty_criteria`,
    ),

    // 4. Re-add nonempty_criteria constraint including required_group_id
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_nonempty_criteria CHECK (min_age IS NOT NULL OR max_age IS NOT NULL OR gender IS NOT NULL OR required_group_id IS NOT NULL)`,
    ),

    // 5. Drop old composite unique constraint (did not include required_group_id)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules DROP CONSTRAINT age_threshold_rules_team_group_criteria_unique`,
    ),

    // 6. Re-add composite unique constraint including required_group_id — NULLS NOT DISTINCT (PG15+)
    Effect.tap(
      () =>
        sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_team_group_criteria_unique UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender, required_group_id)`,
    ),
  ),
);
