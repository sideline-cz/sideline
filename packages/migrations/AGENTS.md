# Migrations Package (`@sideline/migrations`)

Database migrations using Effect SQL with PostgreSQL.

## Architecture

Exports `MigratorLive` — a layer that only needs a `PgClient` and filesystem. Consumers (like `server/run.ts`) provide their own `PgClient`, keeping this package decoupled from connection config.

## Migration Files

Migration files live in `src/` and follow the naming pattern:

```
{timestamp}_{description}.ts
```

Example: `1740970000_create_role_sync.ts`

## Conventions

- Migrations are applied in timestamp order
- Each migration should be idempotent where possible
- Use `TIMESTAMPTZ` for all timestamp columns
- Use `VARCHAR` with appropriate lengths for string columns
- Add appropriate indexes for frequently queried columns
- Foreign keys should have `ON DELETE` behavior specified

### Adding Columns to Existing Tables

Use `ALTER TABLE ... ADD COLUMN` with separate statements per column. Chain statements with `Effect.tap`:

```typescript
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE groups ADD COLUMN color TEXT`),
    Effect.tap(() => sql`ALTER TABLE rosters ADD COLUMN emoji TEXT`),
  ),
);
```

New nullable columns do not need a `DEFAULT` clause — PostgreSQL defaults to `NULL`. Add `NOT NULL DEFAULT ...` only when the column must never be null.

### Partial Indexes for Hot Filters

When a cron or query repeatedly scans a table for rows matching a stable predicate (e.g. "active unclaimed trainings for team X"), prefer a partial index over a full index. Use `CREATE INDEX IF NOT EXISTS ... WHERE ...`:

```typescript
Effect.tap(
  () => sql`
    CREATE INDEX IF NOT EXISTS idx_events_claimed_by_unclaimed
      ON events (team_id)
      WHERE event_type = 'training' AND status = 'active' AND claimed_by IS NULL
  `,
),
```

Partial indexes only contain the matching rows, so they stay small and avoid bloat from inactive/historical data.

### Updating CHECK Constraints

To add a new value to an existing CHECK constraint (e.g. adding a status enum value), drop the old constraint and create a new one:

```typescript
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE events DROP CONSTRAINT events_status_check`),
    Effect.tap(
      () =>
        sql`ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (status IN ('active', 'cancelled', 'started'))`,
    ),
  ),
);
```

Always use the exact constraint name. Check the original migration that created the constraint for the name.

### Unique Constraints with Nullable Columns

The deployed PostgreSQL major version is 17 (see `applications/server/test/integration/globalSetup.ts`), so PostgreSQL 15+ syntax is available. When a composite `UNIQUE` constraint contains nullable columns and you want `NULL` values to collide (i.e. treat `NULL` as a regular distinct value for uniqueness), use `UNIQUE NULLS NOT DISTINCT`:

```typescript
Effect.tap(
  () =>
    sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_team_group_criteria_unique UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)`,
),
```

Without `NULLS NOT DISTINCT`, two rows that differ only by `NULL` values in the constrained columns would both be accepted — usually not what you want when the `NULL`s represent "any" / "no filter" semantics.
