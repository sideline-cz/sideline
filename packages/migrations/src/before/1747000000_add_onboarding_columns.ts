import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE teams
      ADD COLUMN rules_channel_id              TEXT,
      ADD COLUMN onboarding_rules_role_id       TEXT,
      ADD COLUMN onboarding_rules_prompt_id     TEXT,
      ADD COLUMN onboarding_locale              TEXT NOT NULL DEFAULT 'en'
        CHECK (onboarding_locale IN ('en', 'cs')),
      ADD COLUMN onboarding_synced_at           TIMESTAMPTZ,
      ADD COLUMN onboarding_sync_status         TEXT NOT NULL DEFAULT 'pending'
        CHECK (onboarding_sync_status IN ('pending', 'syncing', 'done', 'failed')),
      ADD COLUMN onboarding_sync_error          TEXT;

    ALTER TABLE bot_guilds
      ADD COLUMN is_community_enabled BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE discord_guild_roles (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      guild_id    TEXT NOT NULL REFERENCES bot_guilds(guild_id) ON DELETE CASCADE,
      role_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      color       INTEGER NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0,
      managed     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (guild_id, role_id)
    );

    CREATE INDEX idx_teams_onboarding_pending ON teams(onboarding_sync_status)
      WHERE onboarding_sync_status IN ('pending', 'syncing');
  `,
);
