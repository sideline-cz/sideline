import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Per-team override for the BODY of the pinned intro embed in the verify channel
// (`nez-zacnes` / `start-here`). NULL = use the built-in `m.bot_verify_intro_description`.
//
// Plain text, no template placeholders — unlike `welcome_message_template`, which renders
// `{memberMention}` and friends. Nothing sets this at insert time, so the domain model keeps
// it off the insert variant (`Model.Generated`) and NULL is the only value a new team gets.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS verify_intro_template TEXT
  `,
);
