import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE carpools (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        event_id UUID REFERENCES events(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL,
        discord_channel_id TEXT NOT NULL,
        discord_message_id TEXT,
        created_by UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE carpool_cars (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        carpool_id UUID NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
        owner_team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        capacity INT NOT NULL CHECK (capacity >= 1 AND capacity <= 8),
        thread_id TEXT,
        note VARCHAR(200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (carpool_id, owner_team_member_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE carpool_seats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        car_id UUID NOT NULL REFERENCES carpool_cars(id) ON DELETE CASCADE,
        carpool_id UUID NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        assigned_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (carpool_id, team_member_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX IF NOT EXISTS idx_carpool_cars_carpool ON carpool_cars (carpool_id)`,
    ),
    Effect.tap(
      () => sql`CREATE INDEX IF NOT EXISTS idx_carpool_seats_car ON carpool_seats (car_id)`,
    ),
  ),
);
