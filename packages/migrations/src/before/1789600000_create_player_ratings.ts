import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE player_ratings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        rating INT NOT NULL DEFAULT 1200,
        games_played INT NOT NULL DEFAULT 0 CHECK (games_played >= 0),
        wins INT NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INT NOT NULL DEFAULT 0 CHECK (losses >= 0),
        draws INT NOT NULL DEFAULT 0 CHECK (draws >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(team_id, team_member_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_player_ratings_team ON player_ratings(team_id, rating DESC)`,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE player_rating_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        rating_before INT NOT NULL,
        rating_after INT NOT NULL,
        delta INT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
        game_id UUID,
        submitted_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_player_rating_history_member ON player_rating_history(team_member_id, created_at DESC, id DESC)`,
    ),
  ),
);
