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

### Reinterpreting Stored Values: Guard On A Fact Column, Never On The Value

A migration that **reinterprets** already-stored values (converting a `TIME` that was treated as UTC into a team-local wall clock, re-anchoring a `TIMESTAMPTZ` to team-local midnight) is not idempotent by nature: running it twice shifts the value twice. A value-based guard cannot fix this — it cannot distinguish "not converted yet" from "already converted", because every clock/instant value is reachable both before and after conversion for *some* timezone, and a UTC+0 team's value is identical either way.

Rules:

1. **Add a `BOOLEAN NOT NULL DEFAULT FALSE` marker column to the table being reinterpreted**, via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — either in the same migration as the conversion `UPDATE`, or in an earlier migration (both markers in this repo do the latter; see the references below).
2. **Guard the `UPDATE` on `WHERE NOT <marker>` and set `<marker> = TRUE` in the SAME statement.** Guard and write must never be two statements — a crash between them leaves the row's state and its marker disagreeing.
3. **Never drop the marker column** in a later migration. It is the only thing that makes the conversion safely re-runnable by hand against a partially-migrated database.
4. **Never derive the guard from the data** (`WHERE start_time <> '00:00'`, `WHERE start_at <> date_trunc('day', start_at)`, or any other value predicate).

```typescript
Effect.tap(
  () => sql`
    ALTER TABLE event_series
      ADD COLUMN IF NOT EXISTS times_are_team_local BOOLEAN NOT NULL DEFAULT FALSE
  `,
),
Effect.tap(
  () => sql`
    UPDATE event_series es
    SET start_time = /* ...conversion... */,
        times_are_team_local = TRUE
    WHERE NOT es.times_are_team_local
  `,
),
```

References: `times_are_team_local` (`1791700000_add_series_times_team_local_flag.ts` adds the marker column and converts nothing; the guarded conversion `UPDATE` landed separately in `1792100000_series_time_is_team_local.ts` — see `applications/server/AGENTS.md` → "Series Times Are Team-Local Wall Clock"), `all_day_anchored` (`1791300000_add_all_day_anchored_flag.ts` + `1791400000_anchor_all_day_to_team_midnight.ts`).

> The reserved id above was originally `1791800000`. Production kept shipping migrations (through `1792000005`) while this one sat unwritten, so `1791800000` fell below the migrator's applied-id waterline: `Migrator.js` only checks `currentId <= latestMigrationId`, and a migration below that line is skipped silently — no error, no log line, forever. It was renumbered to `1792100000`, comfortably above every id merged so far. `scripts/check-migration-ids.mjs` now enforces this (new ids on a branch must exceed every id already on `origin/main`) so it cannot happen again unnoticed.

> **Use `node scripts/check-migration-ids.mjs`'s suggested id.** On failure it prints `next safe id: <highest id on origin/main> + 100000`. `1792100000_series_time_is_team_local.ts` has landed, so there is no live reservation to protect anymore — the earlier caveat here only applied while that id sat unwritten below the waterline described above.

### Reading A Per-Team Setting Inside A Migration `UPDATE`

Migrations that re-derive a column from `team_settings` (timezone, horizon days) must read that setting with a **correlated scalar subselect wrapped in `COALESCE`**, never `UPDATE ... FROM team_settings`.

1. **`UPDATE ... FROM team_settings` is an INNER JOIN.** Every row whose team has no `team_settings` row is silently skipped — no error, no count difference anyone checks, and those rows stay unconverted forever. A `COALESCE((SELECT ...), '<default>')` subselect converts them using the documented default instead.
2. **When the setting is an IANA timezone used in `AT TIME ZONE`, join `pg_timezone_names`.** `team_settings.timezone` carries `team_settings_timezone_check` (`1792000005_team_settings_timezone_check.ts`), but that CHECK is strictly weaker than this join and does NOT replace it: it only asserts `AT TIME ZONE` resolves, so the abbreviation `EST`, the POSIX offset `UTC+3` and lowercase `europe/prague` all pass it while none of the three is a `pg_timezone_names.name` row (verified on `postgres:17`); and any migration whose id is below `1792000005` runs before the constraint exists at all. `AT TIME ZONE '<garbage>'` raises `ERROR: time zone "..." not recognized` (SQLSTATE `22023`, NOT a `23514` check violation), which fails the migration transaction. `MigrateBefore` runs inside server boot (`applications/server/src/run.ts`), so one bad row anywhere in the table means the container never starts — for every team, not just that one. The join makes an unrecognised value return no row, so `COALESCE` falls back.
3. **`COALESCE` alone is not the guard.** It only substitutes for a NULL (missing row); a non-NULL garbage string passes straight through to `AT TIME ZONE`. Both defences are required together.
4. **Use `'Europe/Prague'` as the timezone fallback** — the same default the `team_settings.timezone` column carries and the same one `resolveOccurrenceInstant` uses (`applications/server/src/utils/seriesOccurrence.ts`), so SQL and application code agree on invalid-zone behaviour.
5. **`pg_timezone_names.name` matching is case-sensitive.** `n.name = ts.timezone` rejects `europe/prague` and falls back. The app only ever writes canonical IANA casing, so do not switch to `ILIKE` — that would silently normalise a wrong-but-similar value instead of falling back.

```sql
AT TIME ZONE COALESCE(
  (SELECT ts.timezone FROM team_settings ts
     JOIN pg_timezone_names n ON n.name = ts.timezone
   WHERE ts.team_id = es.team_id),
  'Europe/Prague')
```

Reference: `1792100000_series_time_is_team_local.ts` (both statements) — it is the deferred half of the split described in `applications/server/AGENTS.md` → "Series Times Are Team-Local Wall Clock", and it is now **the** reference implementation of the `pg_timezone_names`-inside-`COALESCE` pattern. `1791400000_anchor_all_day_to_team_midnight.ts` uses the `COALESCE` scalar subselect of rule 1 WITHOUT the rule-2 join, and `1792000005_team_settings_timezone_check.ts` uses `pg_timezone_names` only as a `NOT IN` sanitize filter — both are only partial patterns; do not copy either as the complete one. The JS/Postgres disagreement for DST-ambiguous wall clocks is documented in `applications/server/AGENTS.md` → "Series Times Are Team-Local Wall Clock".

### A Bulk `UPDATE` That Changes A Uniquely-Indexed Value Must Drop And Recreate That Index

Postgres checks a non-deferrable `UNIQUE` index **per row, as each row is written** — not at statement end. A single `UPDATE` that rewrites the indexed value for two or more rows sharing a key group therefore aborts with `duplicate key value violates unique constraint` as soon as one row lands on another row's still-live value, **even when the final state contains no duplicate at all**. Which rows collide is decided by the plan's row order (heap order under a sequential scan), so the same statement passes on a small dev database and fails in production. Verified on `postgres:17`: over rows `(1,1),(2,2)` with a unique index on `pos`, `UPDATE w SET pos = v.new_pos FROM (VALUES (2,1),(1,0)) v(id,new_pos) WHERE w.id = v.id` fails, while the identical final state reached in the opposite row order succeeds.

Bracket the `UPDATE` with these four statements, in exactly this order:

```typescript
Effect.tap(() => sql`SET LOCAL lock_timeout = '5s'`),
Effect.tap(() => sql`DROP INDEX IF EXISTS idx_events_series_date`),
Effect.tap(() => sql`UPDATE events e SET start_at = /* ...rewrite of the indexed value... */`),
Effect.tap(
  () => sql`
    CREATE UNIQUE INDEX idx_events_series_date
      ON events(series_id, ((start_at AT TIME ZONE 'UTC')::date)) WHERE series_id IS NOT NULL
  `,
),
```

Rules:

1. **`SET LOCAL lock_timeout` comes FIRST, before any DDL in a `MigrateBefore` migration.** `MigrateBefore` runs inside server boot (`applications/server/src/run.ts`) during a blue-green window in which the PREVIOUS container is still serving and querying the table. Without a timeout, one long-running query over there makes boot block indefinitely on the `ACCESS EXCLUSIVE` lock AND queues every subsequent query on that table behind the pending lock request. `SET LOCAL` is correct because the migrator wraps the whole pending set in one transaction; `'5s'` is the value in use. Same idiom and reasoning as `applications/server/src/api/group.ts` (`applications/server/AGENTS.md` → "Per-Team Advisory Lock Guarding an Invariant Check", rule 2).
2. **Copy the `CREATE UNIQUE INDEX` definition verbatim from the migration that created the index** (here `1741800000_event_datetime_columns.ts`), including the partial `WHERE`. A recreated index that differs from the original is silent schema drift.
3. **Use `DROP INDEX IF EXISTS`, and an unconditional `CREATE UNIQUE INDEX`.** The unconditional create converges the schema either way, so `IF EXISTS` on the drop costs nothing and stops a merely-absent index from becoming a boot failure.
4. **Never `CREATE INDEX CONCURRENTLY` in a migration.** It cannot run inside a transaction, and the migrator runs the whole pending set in one.
5. **Dropping the index does not weaken the invariant — it strengthens the failure mode.** A genuine final-state duplicate now fails at index-build time and rolls the whole transaction back, instead of aborting partway through a per-row check.
6. **Do not work around the collision by splitting the `UPDATE` into per-row statements** (the same collision, N times over) **or by making the index deferrable** — `DEFERRABLE` exists only on a `UNIQUE` *constraint*, and a partial unique index cannot be a constraint at all.

Testing rules (both are mandatory; each catches a deletion the other misses):

1. **Force the worst-case access path in the collision test:** `SET LOCAL enable_indexscan = off` and `SET LOCAL enable_bitmapscan = off`, issued inside the SAME `sql.withTransaction` as the migration run so the settings and the `UPDATE` share one connection. With only a handful of rows the planner satisfies the join through the very index under test, and that index scan visits rows in ascending key order — sidestepping the collision entirely, so the test passes even with the drop/recreate bracket deleted.
2. **Assert the index was recreated by reading `pg_indexes.indexdef` back and comparing it to a pinned literal** of the original definition. Without that assertion, deleting the trailing `CREATE UNIQUE INDEX` leaves every other case green while production silently loses the index.

Reference: `1792100000_series_time_is_team_local.ts`; coverage in `applications/server/test/integration/migrations/seriesTimeIsTeamLocal.test.ts` (case `B15`, unique-index collision).

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

### A "One Row Per Team" Flag: Column → Backfill → Partial Unique Index, In That Order

A boolean that may be `true` for at most one row per team (`roles.is_default` — which role new members receive) is enforced by the DB, never by application code. The three statements MUST appear in this order in one migration:

```typescript
// 1. Add the column with the value that preserves today's behaviour.
Effect.tap(() => sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`),
// 2. Backfill the row that already had the behaviour implicitly.
Effect.tap(() => sql`
  UPDATE roles SET is_default = true
  WHERE name = 'Player' AND is_built_in = true AND is_archived = false AND is_default = false
`),
// 3. Index LAST, so it validates the state the backfill just produced.
Effect.tap(() => sql`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_team_default
  ON roles(team_id) WHERE is_default AND NOT is_archived
`),
```

Rules:

1. **Create the unique index AFTER the backfill, never before.** Creating it first lets a backfill that produces two `true` rows for one team abort the migration mid-flight — and `MigrateBefore` runs inside server boot, so an aborted migration means the container never starts (see "Widening a UNIQUE Constraint"). Index-last turns the same bad backfill into a failure that names the index and the duplicate key.
2. **The backfill must be behaviour-preserving and idempotent.** `AND is_default = false` makes a re-run a no-op; the `WHERE` must select exactly the row that already had the behaviour implicitly (here: the built-in `Player` every team was seeding into new members before the column existed). A migration that picks a *new* winner is a behaviour change disguised as a backfill.
3. **Exclude soft-deleted rows from the index predicate** (`WHERE is_default AND NOT is_archived`), so an archived row never occupies the team's single slot. The application must clear the flag in the same statement that archives (`UPDATE roles SET is_archived = true, is_default = false`), or un-archiving later resurrects a second default.
4. **Verify the backfill cannot collide with the index before writing it.** Here it cannot: `idx_roles_team_name` is a full unique index on `(team_id, name)`, so at most one `'Player'` row exists per team. State that reasoning in a comment on the backfill — a reviewer cannot re-derive it from the migration alone.
5. **Application writes against this index need a row lock, not just a transaction** — see `applications/server/AGENTS.md` → "The Team's Default Role Resolves In Exactly One Place", rules 4 and 5.

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

**Sanitize existing rows BEFORE `ADD CONSTRAINT`, in the same migration.** `ADD CONSTRAINT` evaluates the expression against every existing row, so one violating row aborts the migration — and `MigrateBefore` runs inside server boot (`applications/server/src/run.ts`), so that abort means the container never starts, for every team. Order the statements `1. UPDATE` (repair) `2. DROP CONSTRAINT IF EXISTS` `3. ADD CONSTRAINT`, never any other order. This is mandatory, not defensive, when the expression can RAISE instead of returning `FALSE`: `now() AT TIME ZONE timezone` raises `time zone "..." not recognized` (SQLSTATE `22023`) for an unrecognised zone, so the failure never surfaces as a `23514` check violation — neither at `ADD CONSTRAINT` time nor on a later rejected write, which is why no handler may detect it by matching `23514`. Reference: `1792000005_team_settings_timezone_check.ts` rewrites `team_settings.timezone` to `'Europe/Prague'` for every row not in `pg_timezone_names` before adding `team_settings_timezone_check`; coverage in `applications/server/test/integration/migrations/teamSettingsTimezoneCheck.test.ts`.

**Rolling-deploy-safe enum widening.** When the new value cannot yet appear on the wire for already-deployed clients (see `packages/domain/AGENTS.md` → wire-value projection), widen the CHECK to a permissive **superset** that keeps every legacy value AND the new one (`CHECK (response IN ('yes', 'no', 'maybe', 'coming_later'))`), use `DROP CONSTRAINT IF EXISTS` so the widening is idempotent, and do NOT rewrite historical rows in this migration. Eagerly converting historical rows would expose an old still-running instance's legacy decode to every historical row (not just newly-written ones) during the rolling deploy, for no functional benefit — the app already tolerates both the legacy and new values this release. Drop the legacy value from the CHECK and convert any leftover rows in the Release B follow-up, once no client relies on the old value. Reference: `1790300016_rename_rsvp_maybe_to_coming_later.ts`.

**A deferred "convert the legacy rows later" note is a CLAIM, not a fact — re-derive it before you act on it.** The `1790300016` note above deferred converting historical `'maybe'` rows to `'coming_later'` in a Release B follow-up. That follow-up was investigated in `feat/adjust-later-option` and DELIBERATELY NOT WRITTEN, because the premise was wrong. Before writing any migration that REINTERPRETS a stored literal (as opposed to renaming one), you MUST establish what that literal meant to the user who wrote the row, by reading the UI label in force at the time:

```bash
git log --oneline -- packages/i18n/messages/en.json   # find the commit that changed the label
git show <commit>^:packages/i18n/messages/en.json | grep <message_key>
```

Here `git show 5ec1fcba^:packages/i18n/messages/en.json` shows `"bot_btn_maybe": "❓ Maybe"` (cs: `"❓ Možná"`) — before #549 the button was literally labelled *Maybe*, so every historical `'maybe'` row already meant "Nevím" / "Not sure". Converting them would have (1) rewritten real user answers into their opposite — "I don't know" recorded as "I am definitely coming, just late" — with no way back, since the original value is destroyed by the `UPDATE`, and (2) minted `coming_later` rows with `message IS NULL`, violating the mandatory-note invariant that `applications/server/src/utils/rsvpMessageRequired.ts` enforces on every write. Two rules follow:

1. **A reinterpreting `UPDATE` is irreversible in a way a renaming one is not.** A rename preserves the answer and changes its spelling; a reinterpretation changes the answer. Where you cannot prove from the historical UI that every affected row meant the new thing, do not write the migration — leave the rows and say so.
2. **Do NOT tighten `event_rsvps_response_check` to drop `'maybe'`.** `'maybe'` is actively written again as a first-class response; the four-literal superset `CHECK (response IN ('yes', 'no', 'maybe', 'coming_later'))` is the permanent shape, not a transitional one.

### Widening a UNIQUE Constraint (Add the Wider Index BEFORE Dropping the Narrower One)

Widening uniqueness from `(a, b)` to `(a, b, c)` is not a `DROP` followed by a `CREATE`. Order the statements so the table is never unprotected, and account for the fact that dropping the old constraint breaks in-flight `ON CONFLICT` clauses.

```typescript
// 1. Column, with a DEFAULT that makes every existing row a valid member of the new key.
Effect.tap(() => sql`ALTER TABLE personal_event_channels ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'all'`),
// 2. Value guard (see "Updating CHECK Constraints" above).
// 3. Wider unique index FIRST — CREATE UNIQUE INDEX IF NOT EXISTS, so the re-run is a no-op.
Effect.tap(() => sql`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_event_channels_member_bucket
    ON personal_event_channels (team_id, team_member_id, bucket)
`),
// 4. Only then drop the narrower one, by its exact generated name, with IF EXISTS.
Effect.tap(() => sql`
  ALTER TABLE personal_event_channels
    DROP CONSTRAINT IF EXISTS personal_event_channels_team_id_team_member_id_key
`),
```

1. **Create the wider index before dropping the narrower constraint, never the other way round.** Between the two statements the table must be protected by at least one of them. The reverse order opens a window in which duplicate rows can be written and the subsequent `CREATE UNIQUE INDEX` then aborts the migration — and `MigrateBefore` runs inside server boot (`applications/server/src/run.ts`), so an aborted migration means the container never starts, for every team.
2. **The DEFAULT on the new column must make every existing row a valid member of the new key.** `bucket TEXT NOT NULL DEFAULT 'all'` turns each pre-existing `(team_id, team_member_id)` row into exactly one `(team_id, team_member_id, 'all')` row, so the wider index can be built without a repair `UPDATE`.
3. **An inline `CREATE TABLE ... UNIQUE (a, b)` constraint carries a Postgres-generated name** — `<table>_<col1>_<col2>_key`. Look it up in the migration that created the table; do not guess, and always pair the `DROP` with `IF EXISTS` so a re-run is a no-op.
4. **Dropping the narrower constraint breaks OLD application pods' `ON CONFLICT (a, b)` clause** — Postgres needs a unique index matching the inferred conflict target exactly and raises `42P10` (`there is no unique or exclusion constraint matching the ON CONFLICT specification`) otherwise. During a rolling deploy the still-running old pods therefore fail every upsert on that table until they are replaced. Deploy the server before the bot, expect a gap on whatever the upsert feeds, and say so in a comment on the `DROP` statement. When that gap is not acceptable, split the widening across two releases: this migration plus the new code in Release A, and the `DROP CONSTRAINT` in Release B.
5. **Idempotently ADDING a brand-new constraint** (as opposed to replacing one) needs a guard, because `ADD CONSTRAINT` has no `IF NOT EXISTS`: wrap it in `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '<name>') THEN ... END IF; END $$`. Use the `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` pair from "Updating CHECK Constraints" only when you are REPLACING an existing constraint of a known name.

Reference: `1792200001_personal_event_channels_bucket.ts`; coverage in `applications/server/test/integration/migrations/personalEventChannelsBucket.test.ts`.

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
5. **Adding a SECOND source table to an existing recompute function transfers that function's lock-acquisition obligation to every writer of the new table.** The recompute function takes a `FOR UPDATE` row lock (contract item 2) that is invisible at the call site, so a new trigger on a new source table silently inserts that lock into every transaction writing that table. Before adding the trigger, list every writer of the new source table and confirm each already holds the locks that precede this one in the codebase's canonical order (root `AGENTS.md` → "Bank Sync (Fio)", invariant 2), then record the reasoning in a comment beside the `CREATE TRIGGER`. Worked example: `1792800001_auto_credit_bank_transfers.ts` extends `recompute_bank_match_state` to sum `member_credit_deposits` alongside `payments` and adds `credit_deposits_bank_recompute_trigger`; that trigger takes `bank_transactions`, and all three deposit writers (`MemberCreditsRepository.settle`, `MemberCreditsRepository.voidDeposit`, `BankTransactionMatcher.writeAutoCredit`) already hold the `member_credit_accounts` lock when they write a deposit.
6. **Reuse `CREATE OR REPLACE FUNCTION` only with a byte-identical signature.** A changed parameter list creates an OVERLOAD instead of replacing the function, leaving the old body live for every existing caller — and no error is raised. `1792800001`'s replacement of `recompute_bank_match_state` keeps `(p_tx_id UUID, p_void_suppress BOOLEAN DEFAULT false)` unchanged from `1792000002` for exactly this reason.

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

### Deep default-importing a migration file for testing needs `fix-dts-module-type`

Some tests (e.g. an integration test that runs a data-migration's own `Effect` directly against seeded rows, rather than only through the migrator) import a single migration file by its default export via a deep subpath: `import myMigration from '@sideline/migrations/before/<id>_<name>'`.

This package publishes a dual CJS/ESM build via `build-utils pack-v2`, and its root `dist/package.json` deliberately has **no** `"type"` field (so `main`/`require()` stay CommonJS while `exports.*.import` serves ESM — the standard dual-package-hazard-free layout). `build-utils pack-v2` writes a `{"type":"module"}` marker into `dist/dist/esm/` so the ESM `.js` output is unambiguous, but it does **not** write one into `dist/dist/dts/`. TypeScript's Node16/NodeNext module-format detection for a `.d.ts` file (an extension-ambiguous format) walks up to the **nearest** `package.json` regardless of which `exports` condition (`import`/`default`) was actually matched — so without a marker in `dist/dist/dts/`, it falls back to the un-marked `dist/package.json` and infers **CommonJS**. Under `esModuleInterop: false` (`tsconfig.base.json`), a CJS-format `.d.ts`'s default import types as the **whole module namespace**, not the exported `Effect` value — even though the file's own source says `export default`, and even though the real runtime `.js` (loaded via the `import` condition) is genuinely ESM and behaves correctly. The result: `tsc` reports the imported migration is "missing `[TypeId]`, `pipe`, `asEffect`, …" — i.e. it thinks you imported a namespace object, not an `Effect`.

Fixed by the package's own `build` script: `pnpm fix-dts-module-type` (run after `build-utils pack-v2`, before the build script exits) writes `dist/dist/dts/package.json` with `{"type":"module"}`, mirroring `dist/dist/esm/package.json`, so TS's format detection for the declaration file matches the ESM `.js` file it actually describes. Do not remove this step — a fresh `pnpm build` without it silently reintroduces the false-namespace typing for every deep default import of a migration file, with no runtime symptom (the runtime `.js` resolution was never broken) and no signal besides `tsc` errors that look like a genuinely broken export.
