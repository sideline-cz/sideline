import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE achievement_settings (
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          achievement_slug TEXT NOT NULL,
          threshold_override INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (team_id, achievement_slug)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE custom_achievements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          emoji TEXT,
          rule_kind TEXT NOT NULL,
          threshold INTEGER NOT NULL CHECK (threshold > 0),
          activity_type_slug TEXT,
          discord_role_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (team_id, name)
        )
      `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_custom_achievements_team ON custom_achievements(team_id)`,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE discord_role_provision_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          desired_name TEXT NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ,
          error TEXT,
          UNIQUE (team_id, kind, ref_id)
        )
      `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_drpe_unprocessed ON discord_role_provision_events(created_at) WHERE processed_at IS NULL`,
    ),
  ),
);
