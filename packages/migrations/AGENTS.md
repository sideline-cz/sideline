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

### Timestamp ID Must Be Strictly Greater Than the Highest Already-Applied ID

The migration runner records applied ids in `migrations_*` and re-applies only ids strictly greater than the highest recorded id. A new migration with a timestamp lower than (or equal to) any already-applied id is **silently skipped in every environment where the higher id has already run** (CI preview DBs, staging, production). The file appears merged but the schema never changes.

Rules when adding a new migration file:

1. **Run `ls -1 packages/migrations/src/before/ | sort | tail -1`** before choosing a filename. The new timestamp must be strictly greater than that last entry. Do not pick a "round" number from the past (e.g. `1747700000`) when the latest applied id is already `1778716800` — pick something like `1779000000` (greater than every existing id, rounded up from `Date.now() / 1000` is fine).
2. **Never renumber an existing migration** to fix this — the old timestamp is already recorded as applied in preview/staging DBs, so renaming the file orphans the recorded row. Add a new migration with a strictly-greater timestamp instead.
3. This rule applies to both `src/before/` and any future migration directories — the runner uses one monotonically-increasing id sequence per directory.

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

### Trigger-Maintained Denormalized Aggregates

When a derived aggregate (e.g. `fee_assignments.paid_minor = SUM(payments.amount_minor) WHERE voided_at IS NULL`) is read on every status query, prefer a **trigger-maintained denormalized column** over re-aggregating with `SUM(...)` on each read. Reference implementation: `recompute_paid_minor` + `payments_recompute_trigger` in `1783000000_create_finance.ts`.

Schema contract:

1. The denormalized column lives on the parent row (e.g. `fee_assignments.paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0)`).
2. A `RETURNS void` PL/pgSQL function (`recompute_<column>(p_parent_id UUID)`) recomputes the value from the source rows and UPDATEs the parent. **The function MUST `PERFORM 1 FROM <parent> WHERE id = p_parent_id FOR UPDATE`** before the UPDATE to serialize concurrent recomputations — without the row lock, two concurrent payment writes can both read the same `SUM(...)` and one overwrites the other.
3. An `AFTER INSERT OR UPDATE OR DELETE` trigger on the source table calls the recompute function with the affected parent id. On `UPDATE` that changes the FK (`OLD.fk <> NEW.fk`), the trigger MUST recompute both the old and new parents in the same firing.
4. Define both function and trigger **in the same migration** that creates the source table. Adding the trigger later requires a `UPDATE ... SET <col> = (SELECT SUM ...)` backfill, which is easy to forget.

Rules:

1. **Never write to the denormalized column from application code.** All writes go through the source table; the trigger maintains the parent. The repository layer reads `paid_minor` directly — never `SELECT SUM(...)`.
2. **Always include `WHERE voided_at IS NULL`** (or the equivalent "active" predicate) inside the recompute SUM. A void/soft-delete that does not update the trigger's predicate corrupts the denormalized value.
3. **Pair the column with a SQL view that derives status from it** (e.g. `fee_assignment_status_v` derives `'paid' | 'partial' | 'overdue' | 'pending' | 'waived'` from `paid_minor`, `amount_minor`, `due_at`, `stored_status`). Read status through the view, not by re-running `CASE WHEN` in TypeScript — keeps the rule in one place and lets the planner index/filter on view columns.
4. **The view is a stateless `CREATE VIEW`, not `MATERIALIZED VIEW`.** Materialization adds a second cache that must be refreshed; the trigger already maintains the underlying denormalized column.

### Cascade Discipline for Financial / Audit Records

Tables that represent financial transactions, audit trails, or any record that must survive parent-row deletion use `ON DELETE RESTRICT` on every FK that points to a user/member/recorder. Reference: `payments.fee_assignment_id`, `payments.team_member_id`, `payments.recorded_by_user_id`, `payments.voided_by_user_id`, and `fee_assignments.team_member_id` all use `ON DELETE RESTRICT`.

Rules:

1. **Use `ON DELETE RESTRICT` (not `CASCADE`) on FKs from audit/financial rows to users, members, or other audit-bearing parents.** Deleting a user with recorded payments must fail, not silently erase the payment. The application layer handles this by soft-deleting (e.g. `voided_at`) instead of hard-deleting.
2. **Only the soft-archive parent FK (e.g. `fee_assignments.fee_id → fees(id) ON DELETE CASCADE`) may cascade**, because deleting an unused `fees` row (no assignments yet) is a cleanup operation, not a financial event.
3. **Document the cascade choice inline in the migration** with a one-line comment when it deviates from "default to RESTRICT" — future readers should not have to infer policy from column-by-column reading.

### Unique Constraints with Nullable Columns

The deployed PostgreSQL major version is 17 (see `applications/server/test/integration/globalSetup.ts`), so PostgreSQL 15+ syntax is available. When a composite `UNIQUE` constraint contains nullable columns and you want `NULL` values to collide (i.e. treat `NULL` as a regular distinct value for uniqueness), use `UNIQUE NULLS NOT DISTINCT`:

```typescript
Effect.tap(
  () =>
    sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_team_group_criteria_unique UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)`,
),
```

Without `NULLS NOT DISTINCT`, two rows that differ only by `NULL` values in the constrained columns would both be accepted — usually not what you want when the `NULL`s represent "any" / "no filter" semantics.
