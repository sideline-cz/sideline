import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS variable_symbol TEXT`),
    Effect.tap(
      () => sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'team_members_variable_symbol_format') THEN
            ALTER TABLE team_members ADD CONSTRAINT team_members_variable_symbol_format
              CHECK (variable_symbol IS NULL OR variable_symbol ~ '^[0-9]{1,10}$');
          END IF;
        END $$
      `,
    ),
    // Unique per team on the leading-zero-stripped form; multiple NULLs stay legal
    // (members who don't pay). `ltrim(text,text)` and `NULLIF` are IMMUTABLE.
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_team_variable_symbol
          ON team_members (team_id, (NULLIF(ltrim(variable_symbol, '0'), '')))
          WHERE variable_symbol IS NOT NULL
      `,
    ),
  ),
);
