import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE polls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL,
        discord_channel_id TEXT NOT NULL,
        discord_message_id TEXT,
        question VARCHAR(300) NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        multiple BOOLEAN NOT NULL DEFAULT false,
        allowed_role_id TEXT,
        deadline TIMESTAMPTZ,
        created_by UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE poll_options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        label VARCHAR(80) NOT NULL,
        position INT NOT NULL,
        added_by UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (poll_id, position),
        UNIQUE (poll_id, label)
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE poll_votes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (poll_id, team_member_id, option_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id)`,
    ),
    Effect.tap(() => sql`CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id)`),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_poll_votes_member ON poll_votes (poll_id, team_member_id)`,
    ),
  ),
);
