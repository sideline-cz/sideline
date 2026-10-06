import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Lets a team hand out variable symbols on join instead of the treasurer running the bulk
// "Assign variable symbols" dialog after every signup.
//
// NOT NULL DEFAULT false on purpose: off is the current behaviour, so every existing row is
// already correct and the deploy is a no-op. No backfill — turning the switch on does NOT
// retroactively fill in existing members; that is still the bulk dialog's job, which previews
// before it writes. A toggle that silently assigned symbols to 123 existing members would be a
// bulk write with no preview, which §5.3 of the design rules out.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.tap(
    Effect.void,
    () => sql`
      ALTER TABLE team_settings
        ADD COLUMN IF NOT EXISTS auto_assign_variable_symbols BOOLEAN NOT NULL DEFAULT false
    `,
  ),
);
