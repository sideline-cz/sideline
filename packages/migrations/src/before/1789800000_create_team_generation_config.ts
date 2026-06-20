import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE team_generation_config (
        team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        weight_elo INT NOT NULL DEFAULT 100 CHECK (weight_elo BETWEEN 0 AND 1000),
        weight_size INT NOT NULL DEFAULT 50 CHECK (weight_size BETWEEN 0 AND 1000),
        weight_gender INT NOT NULL DEFAULT 20 CHECK (weight_gender BETWEEN 0 AND 1000),
        default_team_count INT NOT NULL DEFAULT 2 CHECK (default_team_count >= 2),
        max_iterations INT NOT NULL DEFAULT 1000 CHECK (max_iterations >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
  ),
);
