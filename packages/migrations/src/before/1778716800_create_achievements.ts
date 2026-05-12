import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE earned_achievements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          achievement_slug TEXT NOT NULL,
          earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (team_member_id, achievement_slug)
        )
      `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_earned_achievements_member ON earned_achievements(team_member_id)`,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE achievement_role_mappings (
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          achievement_slug TEXT NOT NULL,
          discord_role_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (team_id, achievement_slug)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE achievement_sync_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          achievement_slug TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ,
          error TEXT
        )
      `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_achievement_sync_unprocessed ON achievement_sync_events(created_at) WHERE processed_at IS NULL`,
    ),
  ),
);
