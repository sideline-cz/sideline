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
3. **When backfilling a skipped migration, the backfill MUST be idempotent.** The original migration already ran in every environment whose highest applied id was below the original timestamp, so the backfill re-runs the same DDL on those databases. Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ADD COLUMN IF NOT EXISTS` so the re-run is a no-op where the object already exists and creates it where it is missing. Name the file `{newHigherTimestamp}_<original_description>_if_not_exists.ts` and add a header comment naming the original migration it re-runs. Reference: `1789200000_create_team_onboarding_tokens_if_not_exists.ts` backfills the skipped `1747700000_create_team_onboarding_tokens`.
4. This rule applies to both `src/before/` and any future migration directories — the runner uses one monotonically-increasing id sequence per directory.

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

### Backfill `*_sent_at` Idempotency Markers on Add

A cron that emits "one Discord event per row, once" reads a nullable `*_sent_at` marker on the source table as its idempotency signal (see `applications/server/AGENTS.md` → "Self-Healing `*_sent_at` Date-Gated Crons"). When the migration adds such a marker as a fresh `NULL` column, **every already-existing in-window row becomes an unsent candidate on the first deploy**, so the cron fires a backlog blast (e.g. claim requests for every training already scheduled). The same migration MUST backfill the marker to `now()` for rows that would otherwise be re-notified:

```typescript
Effect.tap(() => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS claim_request_sent_at TIMESTAMPTZ`),
// Backfill so the new cron skips pre-existing rows on first deploy
Effect.tap(
  () =>
    sql`UPDATE events SET claim_request_sent_at = now() WHERE event_type = 'training' AND claim_request_sent_at IS NULL`,
),
```

Rules:

1. **Backfill in the SAME migration that adds the marker**, immediately after the `ADD COLUMN IF NOT EXISTS`. A later migration leaves a deploy window in which the cron fires the blast.
2. **Scope the `UPDATE` to the rows the cron actually targets** (e.g. `WHERE event_type = 'training'`) so unrelated rows are untouched.
3. **The backfill must be idempotent** (`... WHERE <marker> IS NULL`) so re-running the migration is a no-op.
4. This applies only when historical rows existing before the feature should be treated as "already handled". If the intended behaviour is to notify the existing backlog, omit the backfill and document that decision inline.

Reference: `1789300000_improve_coach_assigning.ts` backfills `claim_request_sent_at` and `coaching_status_sent_at`.

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

**Rolling-deploy-safe enum widening.** When the new value cannot yet appear on the wire for already-deployed clients (see `packages/domain/AGENTS.md` → wire-value projection), widen the CHECK to a permissive **superset** that keeps every legacy value AND the new one (`CHECK (response IN ('yes', 'no', 'maybe', 'coming_later'))`), use `DROP CONSTRAINT IF EXISTS` so the widening is idempotent, and do NOT rewrite historical rows in this migration. Eagerly converting historical rows would expose an old still-running instance's legacy decode to every historical row (not just newly-written ones) during the rolling deploy, for no functional benefit — the app already tolerates both the legacy and new values this release. Drop the legacy value from the CHECK and convert any leftover rows in the Release B follow-up, once no client relies on the old value. Reference: `1790300016_rename_rsvp_maybe_to_coming_later.ts`.

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

### Per-Row Audit Trigger With Application-Set Actor

When a table is hard-deleted (no `voided_at` / `archived_at` soft-delete column) but must still produce an audit trail per insert / update / delete, define an `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` trigger in the same migration that creates the table. The trigger writes a JSONB snapshot row to a paired `<resource>_history` table. The DELETE actor is read from a session-local Postgres variable (`audit.user_id`) that the repository SETs inside the same transaction as the DELETE — `OLD.updated_by_user_id` is a fallback only.

Reference implementation: `expenses` + `expense_history` + `expenses_audit` function + `expenses_audit_trg` trigger in `packages/migrations/src/before/1786000000_create_expenses.ts`. The repository side lives at `applications/server/src/repositories/ExpensesRepository.ts` — see "Application-Set Audit Actor For Hard Deletes" in `applications/server/AGENTS.md`.

Schema contract (copy verbatim, only renaming `<resource>`):

```typescript
sql`
  CREATE TABLE <resource>_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    <resource>_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
    performed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot JSONB NOT NULL
  )
`,
sql`CREATE INDEX idx_<resource>_history_<resource> ON <resource>_history (<resource>_id, performed_at DESC)`,
sql`
  CREATE FUNCTION <resource>_audit() RETURNS TRIGGER AS $$
  DECLARE
    audit_user_id UUID;
  BEGIN
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO <resource>_history (<resource>_id, operation, performed_by_user_id, snapshot)
        VALUES (NEW.id, 'insert', NEW.created_by_user_id, to_jsonb(NEW));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO <resource>_history (<resource>_id, operation, performed_by_user_id, snapshot)
        VALUES (NEW.id, 'update', NEW.updated_by_user_id, to_jsonb(NEW));
        RETURN NEW;
      ELSIF TG_OP = 'DELETE' THEN
        BEGIN
          audit_user_id := current_setting('audit.user_id', true)::uuid;
        EXCEPTION WHEN OTHERS THEN
          audit_user_id := NULL;
        END;
        IF audit_user_id IS NULL THEN
          audit_user_id := OLD.updated_by_user_id;
        END IF;
        INSERT INTO <resource>_history (<resource>_id, operation, performed_by_user_id, snapshot)
        VALUES (OLD.id, 'delete', audit_user_id, to_jsonb(OLD));
        RETURN OLD;
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '<resource>_audit trigger failed: %', SQLERRM;
      RETURN COALESCE(NEW, OLD);
    END;
  END;
  $$ LANGUAGE plpgsql
`,
sql`
  CREATE TRIGGER <resource>_audit_trg
    AFTER INSERT OR UPDATE OR DELETE ON <resource>
    FOR EACH ROW EXECUTE FUNCTION <resource>_audit()
`,
```

Rules:

1. **Define the table, history table, function, and trigger in the SAME migration.** Adding the trigger later requires backfilling missing INSERT history rows and there is no correct historical actor to use.
2. **The trigger function MUST be wrapped in an outer `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING ...; RETURN COALESCE(NEW, OLD); END;` block** so a malformed snapshot or audit-table outage cannot abort the user's primary write. The history row is best-effort; the main row is the contract.
3. **DELETE-actor lookup MUST use `current_setting('audit.user_id', true)`** (note the `true` second argument — without it, missing setting raises `42704` and aborts). The inner `BEGIN ... EXCEPTION WHEN OTHERS THEN audit_user_id := NULL; END;` block converts a missing or malformed setting into the `OLD.updated_by_user_id` fallback.
4. **`performed_by_user_id` is `ON DELETE RESTRICT`**, not `CASCADE`. Audit rows must survive user-account deletion — GDPR anonymization is a separate per-PR story (document the obligation with `COMMENT ON COLUMN <resource>.created_by_user_id IS 'Author of the <resource>. Future GDPR-erasure stories must anonymize via SET NULL or separate anonymization.'`).
5. **`snapshot` is `JSONB`, not denormalized columns.** Use `to_jsonb(NEW)` / `to_jsonb(OLD)` so the history row captures the full row shape at operation time. Schema migrations to the parent table do not require backfilling history columns.
6. **The repository's DELETE method MUST set the actor before the DELETE using `yield* sql\`SELECT set_config('audit.user_id', ${userId}, true)\``** (not `SET LOCAL`, which cannot accept bind parameters in Postgres — `set_config(name, value, is_local=true)` is the equivalent function form and does accept them). See `applications/server/AGENTS.md` → "Application-Set Audit Actor For Hard Deletes".

### Unique Constraints with Nullable Columns

The deployed PostgreSQL major version is 17 (see `applications/server/test/integration/globalSetup.ts`), so PostgreSQL 15+ syntax is available. When a composite `UNIQUE` constraint contains nullable columns and you want `NULL` values to collide (i.e. treat `NULL` as a regular distinct value for uniqueness), use `UNIQUE NULLS NOT DISTINCT`:

```typescript
Effect.tap(
  () =>
    sql`ALTER TABLE age_threshold_rules ADD CONSTRAINT age_threshold_rules_team_group_criteria_unique UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)`,
),
```

Without `NULLS NOT DISTINCT`, two rows that differ only by `NULL` values in the constrained columns would both be accepted — usually not what you want when the `NULL`s represent "any" / "no filter" semantics.

### Migration id ordering vs. long-lived preview DBs (out-of-order skip hazard)

The Effect `Migrator` is **last-id-wins**: it records the highest applied `migration_id` and only runs migrations whose id is **strictly greater**. A migration with an id **lower** than the recorded maximum is silently **skipped forever** — it is treated as already-past.

This bites when a long-lived **PR preview database** applies a feature branch's higher-id migrations *before* a concurrently-merged `main` migration with a *lower* id reaches that branch (e.g. branch adds `1789500000`, then rebases in main's `1789400006`). After the rebase the preview DB has `1789500000` recorded, so `1789400006` is never run → its columns/tables are missing → the app boots unhealthy against that DB. Fresh dev/prod DBs are unaffected because they apply every migration in id order.

Guidance:

1. **Always pick a timestamp `> max(existing)` AT MERGE TIME**, not at branch-creation time. If `main` advanced while your branch was open, re-check the max during rebase and renumber your migration above it if a lower-id migration merged after yours was written.
2. **A preview DB that has applied an out-of-order set is permanently inconsistent** — the skipped migration won't auto-run. Remediate by applying the missing migration's (idempotent) SQL directly via `bin/psql --pr <PR>` and recording it: `INSERT INTO migrations_before (migration_id, name) VALUES (<id>, '<name>') ON CONFLICT DO NOTHING;`. Then redeploy.
3. This is a **preview-environment hazard only** — it never affects dev/prod migration order. Don't "fix" it by lowering your migration's id below an already-merged one.
