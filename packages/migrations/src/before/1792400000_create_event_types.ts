import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- Step 1: table -----------------------------------------------------
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS event_types (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          -- NULL = render the built-in translated label for kind. Set = team free text.
          name        TEXT,
          kind        TEXT NOT NULL CHECK (kind IN ('training','match','tournament','meeting','social','other')),
          color       TEXT NOT NULL CHECK (color IN ('blue','emerald','purple','amber','cyan','rose',
                                                     'indigo','teal','red','orange','slate','pink','gray')),
          -- Presentation ONLY. Never read by a kind-to-id resolution query.
          position    INTEGER NOT NULL DEFAULT 0,
          archived_at TIMESTAMPTZ,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_event_types_team_position
          ON event_types (team_id, position) WHERE archived_at IS NULL
      `,
    ),
    // The resolution path -- see events_sync_event_type() below.
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_event_types_team_kind_created
          ON event_types (team_id, kind, created_at)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_event_types_team_name
          ON event_types (team_id, lower(name)) WHERE archived_at IS NULL AND name IS NOT NULL
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_event_types_team_default_kind
          ON event_types (team_id, kind) WHERE name IS NULL AND archived_at IS NULL
      `,
    ),

    // ---- Step 2: seed existing teams (idempotent) --------------------------
    // Colours reproduce event-colors.ts:62-99 exactly -- the web sees no change on deploy.
    Effect.tap(
      () => sql`
        INSERT INTO event_types (team_id, name, kind, color, position)
        SELECT t.id, NULL, v.kind, v.color, v.position
        FROM teams t
        CROSS JOIN (VALUES ('training','blue',0), ('match','red',1), ('tournament','orange',2),
                           ('meeting','slate',3), ('social','pink',4), ('other','gray',5))
             AS v(kind, color, position)
        WHERE NOT EXISTS (SELECT 1 FROM event_types et WHERE et.team_id = t.id)
      `,
    ),

    // ---- Step 3: seed trigger for future teams ------------------------------
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION seed_default_event_types() RETURNS trigger AS $$
        BEGIN
          INSERT INTO event_types (team_id, name, kind, color, position)
          VALUES
            (NEW.id, NULL, 'training', 'blue', 0),
            (NEW.id, NULL, 'match', 'red', 1),
            (NEW.id, NULL, 'tournament', 'orange', 2),
            (NEW.id, NULL, 'meeting', 'slate', 3),
            (NEW.id, NULL, 'social', 'pink', 4),
            (NEW.id, NULL, 'other', 'gray', 5);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER seed_default_event_types_trg
          AFTER INSERT ON teams
          FOR EACH ROW EXECUTE FUNCTION seed_default_event_types()
      `,
    ),

    // ---- Step 4: events.event_type_id + backfill ---------------------------
    // Deliberately NULLABLE. ON DELETE SET NULL -- never CASCADE (deletes events), never
    // RESTRICT (blocks team-delete cascade).
    Effect.tap(
      () => sql`
        ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type_id UUID
          REFERENCES event_types(id) ON DELETE SET NULL
      `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX IF NOT EXISTS idx_events_event_type_id ON events (event_type_id)`,
    ),
    Effect.tap(
      () => sql`
        UPDATE events e SET event_type_id = et.id FROM event_types et
        WHERE et.team_id = e.team_id AND et.kind = e.event_type AND e.event_type_id IS NULL
      `,
    ),

    // ---- Step 5: the ownership trigger (created AFTER the backfill) --------
    // events.event_type is trigger-owned. App code may write it, but that write is a request
    // to resolve a type, never the stored value -- this function overwrites it from
    // event_types.kind whenever a valid same-team event_type_id is present.
    // event_types.position is presentation only and must never appear in a query that
    // resolves a kind to an id. Never read event_types.name to make a behavioural decision;
    // route off kind.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION events_sync_event_type() RETURNS trigger AS $$
        DECLARE v_kind TEXT; v_id UUID;
        BEGIN
          -- A caller that changed only the legacy enum is asking for a re-resolve.
          IF TG_OP = 'UPDATE'
             AND NEW.event_type_id IS NOT DISTINCT FROM OLD.event_type_id
             AND NEW.event_type    IS DISTINCT FROM OLD.event_type THEN
            NEW.event_type_id := NULL;
          END IF;

          -- The team_id predicate is THE authorization boundary: a foreign or deleted id is
          -- discarded here, in the one place every writer passes through.
          IF NEW.event_type_id IS NOT NULL THEN
            SELECT et.kind INTO v_kind FROM event_types et
             WHERE et.id = NEW.event_type_id AND et.team_id = NEW.team_id;
            IF v_kind IS NOT NULL THEN NEW.event_type := v_kind;
            ELSE                       NEW.event_type_id := NULL;
            END IF;
          END IF;

          IF NEW.event_type_id IS NULL THEN
            -- CREATION order, never position.
            SELECT et.id INTO v_id FROM event_types et
             WHERE et.team_id = NEW.team_id AND et.kind = NEW.event_type
             ORDER BY (et.archived_at IS NOT NULL), et.created_at, et.id
             LIMIT 1;
            NEW.event_type_id := v_id;   -- may stay NULL; that is legal
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `,
    ),
    // pg_trigger_depth() = 0 -- a team delete would otherwise fan out to one trigger
    // invocation per event, for rows about to be deleted. Also stops a hand-deleted type
    // from silently re-pointing history. team_id is included in UPDATE OF so a team move
    // nulls the id lookup and re-resolves in the new team.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER events_sync_event_type_trg
          BEFORE INSERT OR UPDATE OF event_type, event_type_id, team_id ON events
          FOR EACH ROW WHEN (pg_trigger_depth() = 0)
          EXECUTE FUNCTION events_sync_event_type()
      `,
    ),
  ),
);
