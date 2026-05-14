import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`
        CREATE TABLE IF NOT EXISTS translation_overrides (
          translation_key TEXT NOT NULL,
          locale TEXT NOT NULL CHECK (locale IN ('en','cs')),
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
          PRIMARY KEY (translation_key, locale)
        )
      `,
    ),
    Effect.tap(
      () =>
        sql`
        CREATE TABLE IF NOT EXISTS translation_cache_version (
          id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          version BIGINT NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () =>
        sql`
        INSERT INTO translation_cache_version (id, version) VALUES (1, 1) ON CONFLICT DO NOTHING
      `,
    ),
  ),
);
