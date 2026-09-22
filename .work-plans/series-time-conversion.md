# Deferred Series-Time Conversion — `1792100000_series_time_is_team_local`

> **Status: reviewed, blocker-free, NOT yet implemented.** This plan went through one adversarial
> review that returned BLOCK with two blockers, both verified by executing SQL against
> `postgres:17`, plus eight further findings. All are applied below:
>
> - **Blocker 1** — `idx_events_series_date` (a non-deferrable unique index on
>   `(series_id, (start_at AT TIME ZONE 'UTC')::date)`) makes Statement B abort mid-run for any
>   series whose occurrences shift UTC day, which fails server boot on a forward-only deploy.
>   Handled by a mandatory pre-flight query (§G.1 3b) and a drop/recreate around Statement B.
> - **Blocker 2** — three Statement B test cases were dated in the past, so B's `start_at >= now()`
>   guard excluded them and they never ran; one of the three was the case this plan called its most
>   valuable. Re-dated to 2027 and anchored across a DST boundary so they discriminate.
> - Statement C is **dropped**; the Statement B deviation from the withdrawn `1791600000` is
>   **taken**. Both decisions were confirmed by the review, with better arguments than the original.
>
> Statement A's SQL, the atomicity guarantee, the seven rolling-deploy read paths and the migration
> id were all independently verified and are unchanged. What remains is implementation: the
> migration file, the integration test, and the §E documentation edits.


Release N+1 of the two-release split. Converts **live production data**, **forward-only**
(`majnet deploy rollback` reverts the digest, not the data).

Sources of truth read for this plan: `docs/database.md` (rows at :553 and :2218),
`applications/server/AGENTS.md` → "Series Times Are Team-Local Wall Clock" (rules 1–6),
`packages/migrations/AGENTS.md` → "Reinterpreting Stored Values" + "Reading A Per-Team Setting
Inside A Migration `UPDATE`", `packages/migrations/src/before/1791700000_add_series_times_team_local_flag.ts`,
`applications/server/test/integration/migrations/addSeriesTimesTeamLocalFlag.test.ts`, and the
**withdrawn** `1791600000_series_time_is_team_local.ts` + its test, recovered from commit
`0897f9a1`. Every SQL value quoted below was executed against the running `postgres:17`
(`sideline-postgres-1`), not hand-computed.

---

## 0. Pre-flight: the id is still valid

| Fact | Value |
|---|---|
| Highest id in `packages/migrations/src/before/` | `1792000005_team_settings_timezone_check.ts` |
| Reserved id | `1792100000` |
| Verdict | **Still valid** — `1792100000 > 1792000005`. |

`scripts/check-migration-ids.mjs` enforces "every id added on this branch must exceed every id
already on `origin/main`". Run `node scripts/check-migration-ids.mjs` as the last step before
opening the PR, and again after any rebase.

**If another migration lands on `main` first** (id ≥ `1792100000`):

1. New id = `max(id on origin/main) + 100000`.
2. Rename the file, then update **every** reference. They are:
   - `packages/migrations/AGENTS.md` :104, :106, :126
   - `docs/database.md` :553, :2218
   - `docs/deployment.md` :374
   - `applications/server/AGENTS.md` :1108, :1112, :1116, :1117
   - `applications/server/src/utils/seriesTimeDialect.ts` :25
   - `applications/server/src/utils/seriesOccurrence.ts` :12
   - `applications/server/src/api/team-settings.ts` :345
   - `applications/server/test/EventSeries.test.ts` :1854
   - `applications/server/test/integration/migrations/addSeriesTimesTeamLocalFlag.test.ts` :11, :222, :242
   - `applications/web/test/datetime.test.ts` :265
   - the new migration + its new integration test
3. Re-run `node scripts/check-migration-ids.mjs`.

Do **not** renumber `1791700000`; it is already applied everywhere.

### 0.1 Dangling reference to fix while you are here

`.work-plans/timezone-migration-deploy-window.md` **does not exist** in the tree, yet is cited as
authoritative by `docs/database.md:553`, `applications/server/AGENTS.md:1108`,
`applications/server/src/api/team-settings.ts:353`,
`applications/server/test/integration/api/teamSettingsReanchor.test.ts` (several places) and
`applications/server/test/integration/migrations/addSeriesTimesTeamLocalFlag.test.ts:2`.
Repoint those at **this** file.

---

## A. The three statements

### Shared fragment — the timezone lookup

Used verbatim wherever `<TZ>` appears below:

```sql
COALESCE(
  (SELECT ts.timezone
     FROM team_settings ts
     JOIN pg_timezone_names n ON n.name = ts.timezone
    WHERE ts.team_id = es.team_id),
  'Europe/Prague')
```

Both halves are load-bearing and neither substitutes for the other
(`packages/migrations/AGENTS.md` → "Reading A Per-Team Setting Inside A Migration `UPDATE`"):

- **Correlated scalar subselect, not `UPDATE ... FROM team_settings`.** That form is an INNER
  JOIN: every series whose team has no `team_settings` row is silently skipped, stays `FALSE`
  forever, and nothing errors. `team_settings.team_id` is the PRIMARY KEY
  (`1741600000_rolling_horizon.ts`), so the subselect can never return more than one row and can
  never raise `more than one row returned by a subquery`.
- **`JOIN pg_timezone_names`.** `COALESCE` only substitutes for NULL. A non-NULL garbage string
  (`'Mars/Olympus'`, `''`, `'UTC+3'`, lowercase `'europe/prague'`) flows straight into
  `AT TIME ZONE` and raises `time zone "..." not recognized` — SQLSTATE **`22023`**, not a
  `23514` check violation. `MigrateBefore` runs inside server boot (`applications/server/src/run.ts:297`),
  so one bad row anywhere in `team_settings` means the container never starts, **for every team**.
  `team_settings_timezone_check` (`1792000005`) is strictly weaker than this join and does not
  replace it.
- **Case-sensitive `=`, never `ILIKE`.** `'europe/prague'` must FALL BACK, not be silently
  normalised. Test A6 below pins this non-vacuously.

### Statement A — convert the series times

```sql
UPDATE event_series es
SET start_time = ((es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME ZONE <TZ>)::time,
    end_time   = CASE WHEN es.end_time IS NULL THEN NULL
                      ELSE ((es.start_date + es.end_time) AT TIME ZONE 'UTC' AT TIME ZONE <TZ>)::time
                 END,
    times_are_team_local = TRUE
WHERE NOT es.times_are_team_local
RETURNING es.id
```

**Guard: `WHERE NOT es.times_are_team_local`, with `times_are_team_local = TRUE` set in the SAME
statement.** Mandated by `packages/migrations/AGENTS.md` → "Reinterpreting Stored Values: Guard On
A Fact Column, Never On The Value". A value-based guard is impossible here: for a UTC+0 team the
value is byte-identical before and after, and every clock value is reachable in both dialects for
*some* zone. Guard and write must be one statement — a crash between two statements would leave
the row's value and its marker disagreeing, which is unrecoverable without an external record.

**Why `es.start_date` is the anchor.** It is the exact algebraic inverse of how the value was
encoded: every pre-#650 web write path built the stored value as
`formatUtcTime(localToUtc(values.startDate, values.startTime))` where `values.startDate` **is** the
series' `start_date` (see the diff of `TrainingTypeDetailPage.tsx` in `0897f9a1`). Decoding on the
same date recovers the wall clock the captain typed **when their browser's timezone matched the team's**. It is not an exact inverse in general: `applications/web/src/lib/datetime.ts:7`'s `localToUtc` encodes with `new Date(y, mo-1, d, h, mi)`, i.e. **the editing browser's** zone, not `team_settings.timezone`. For a captain editing while travelling, Statement A recovers a wall clock off by the offset difference, and this is forward-only. The true encoding offset is recorded nowhere, so `start_date` + team zone is genuinely the best available inverse — but it is an inference, not a reconstruction, and §G.1 query 3 is therefore a **mandatory human eyeball** rather than an informational preview. Logged in §H residuals. `CURRENT_DATE` is wrong: the wall
clock applies year-round, so a deploy-date anchor freezes a permanent answer chosen by an
arbitrary timestamp, and would take series that are currently *correct* and make them wrong.
Verified (`Europe/Prague`, stored `17:00`):

| anchor `start_date` | converted `start_time` |
|---|---|
| `2026-01-06` (CET, +1) | `18:00:00` |
| `2026-07-07` (CEST, +2) | `19:00:00` |

The two differ — that is what makes test A9 non-vacuous against a `CURRENT_DATE` implementation.

**Direction of the double `AT TIME ZONE`.** On a *naive* timestamp, `AT TIME ZONE 'UTC'`
REINTERPRETS it as UTC, producing a `timestamptz`. On a `timestamptz`, `AT TIME ZONE <tz>` RENDERS
it as naive local. So the expression is instant → local rendering, which is **total and
single-valued**: Statement A has **no DST gap or ambiguity exposure at all**. (Only Statement B,
which goes local → instant, does.)

**`::time` discards the date.** A conversion may roll the day (`Australia/Sydney`, Jan, `17:00`
→ `2026-01-07 04:00` → stored `04:00:00`). That is intended: only the time-of-day is stored.

**Running it twice.** Second run matches zero rows (`NOT times_are_team_local` is false for every
row the first run touched) → no-op. This is the single most important property in the file; test A2
pins it.

**No `status` filter.** Cancelled series are converted too. The marker must describe every row
honestly; a `FALSE` cancelled series that is later reactivated would otherwise be misread forever.

### Statement B — re-anchor already-materialized future occurrences

> **Decision point.** The withdrawn `1791600000` shipped a different Statement B. It is **wrong**
> for two reachable row classes and I recommend against copying it. Both forms are given; §B.1
> proves the defect with executed SQL. If you want the withdrawn form anyway, take it with the
> residuals in §C7/§C8 written into the release notes.

> **BLOCKER — the unique index must be dropped around Statement B.** Verified by execution.
> `packages/migrations/src/before/1741800000_event_datetime_columns.ts:24` creates, and nothing
> has ever dropped:
>
> ```sql
> CREATE UNIQUE INDEX idx_events_series_date
>   ON events(series_id, ((start_at AT TIME ZONE 'UTC')::date)) WHERE series_id IS NOT NULL
> ```
>
> Statement B rewrites `start_at`, so for every row §G.1 query 3 labels `crosses_day` the indexed
> value changes. The index is **non-deferrable**, so Postgres checks it per row and row 1 can land
> on row 2's still-live date. Executed proof, all on `postgres:17`:
>
> - A series shifting +1 UTC day raises `duplicate key value violates unique constraint` **even
>   though the final state is unique**.
> - A moved `active` event collides with a `cancelled` sibling that B deliberately skips — the
>   partial index has no status predicate.
> - A backward shift **succeeded with rows in ascending physical order and failed on identical
>   data in descending order**. Heap layout decides.
>
> `MigrateBefore` runs inside boot (`applications/server/src/run.ts:297`), so one such series means
> the new container never starts — for every team, mid-deploy, on a forward-only release. This is
> the failure mode the withdrawn `1791600000` also carried, and six prior reviews missed it.
>
> **Statement B must therefore be bracketed, in the same migration and the same transaction:**
>
> ```sql
> DROP INDEX idx_events_series_date;
> -- Statement B (below)
> CREATE UNIQUE INDEX idx_events_series_date
>   ON events(series_id, ((start_at AT TIME ZONE 'UTC')::date)) WHERE series_id IS NOT NULL;
> ```
>
> Not `CONCURRENTLY` — it cannot run inside a transaction, and at §G's O(1000)-row scale the
> `ACCESS EXCLUSIVE` on `events` is milliseconds. The recreate is what preserves safety: a
> *genuine* final-state duplicate now fails loudly at index-build time and rolls the whole
> transaction back, instead of aborting halfway through a per-row check.
>
> §G.1 also gains a **mandatory** pre-flight collision query; any row it returns is a boot failure
> and must be hand-resolved before this merges.

**Recommended form** (ids come from Statement A's `RETURNING`, bound as a `uuid[]`):

```sql
UPDATE events e
SET start_at = ((e.start_at AT TIME ZONE 'UTC')::date + es.start_time) AT TIME ZONE <TZ>,
    end_at   = CASE WHEN es.end_time IS NULL THEN NULL
                    ELSE ((e.start_at AT TIME ZONE 'UTC')::date + es.end_time) AT TIME ZONE <TZ>
               END,
    personal_messages_dirty_at = date_trunc('milliseconds', now())
FROM event_series es
WHERE e.series_id = es.id
  AND es.id = ANY(${convertedIds}::uuid[])
  AND NOT e.series_modified
  AND e.status = 'active'
  AND e.start_at >= now()
```

Guards, each with its reason:

| Guard | Why |
|---|---|
| `e.series_id = es.id` | Only series-generated events have a series time to re-anchor to. A standalone event (`series_id IS NULL`) is not in scope and the join excludes it. |
| `es.id = ANY(convertedIds)` | **New.** Restricts B to series Statement A just converted. Without it B also rewrites events of series that were *already* `TRUE` — see §B.1. |
| `NOT e.series_modified` | `series_modified` is exactly the record of a captain's per-occurrence override (`1741500000_create_event_series.ts`). Never clobber it. Same guard `EventsRepository.updateFutureUnmodified` uses. |
| `e.status = 'active'` | Leave `cancelled` and `started` alone. Moving a started event's `start_at` would re-trigger `EventStartCron` reasoning; moving a cancelled one is pointless churn. |
| `e.start_at >= now()` | Forward-looking correction, not a rewrite of history. Past occurrences already happened at their wrong time; moving them would falsify attendance records. |

`personal_messages_dirty_at = date_trunc('milliseconds', now())` — **unconditional overwrite, not**
the `CASE WHEN ... IS NULL` form used in `src/api/team-settings.ts:329`/:371. Reason:
`PersonalEvents/ClearPersonalMessagesDirty` clears with optimistic concurrency
(`... WHERE id = $1 AND personal_messages_dirty_at = $2`, `EventsRepository.ts:1081`). If the
reconcile worker read stamp `T0`, rendered the **old** time, and then we preserved `T0`, its clear
succeeds and the corrected time never re-renders. Writing a fresh `T1` makes that clear fail, so
the event is re-rendered. `date_trunc('milliseconds', ...)` matches the precision
`EventsRepository` writes, so the optimistic compare works.
(The `CASE` form in `team-settings.ts` has the same latent race. Out of scope; note it in the PR.)

**Running it twice.** On a genuine re-run Statement A converts nothing, `convertedIds` is empty,
`= ANY('{}')` matches nothing, and B is a **provable** no-op — including `personal_messages_dirty_at`,
which is NOT re-stamped. Test B10 asserts the timestamp is byte-identical after the second run,
which the withdrawn (unrestricted) form would fail.

**Empty-array safety.** `= ANY(ARRAY[]::uuid[])` is `false` for every row; no length guard needed.
Precedent for binding a `string[]` this way: `BankTransactionMatcher.ts:267`, `BankSyncPoller.ts:195`.

#### B.1 Why the withdrawn Statement B is wrong

The withdrawn form recovered the occurrence date **in the team's zone** and applied to **all**
series events:

```sql
-- WITHDRAWN — do not copy
SET start_at = ((e.start_at AT TIME ZONE <TZ>)::date + es.start_time) AT TIME ZONE <TZ>,
    end_at   = CASE WHEN es.end_time IS NULL THEN NULL
                    ELSE ((e.end_at AT TIME ZONE <TZ>)::date + es.end_time) AT TIME ZONE <TZ> END,
    ...
FROM event_series es
WHERE e.series_id = es.id AND NOT e.series_modified AND e.status = 'active' AND e.start_at >= now()
```

**The principle both forms are groping at:** *recover the occurrence date in the dialect the event
was materialized in.* A UTC-dialect event was built as `` `${dateStr}T${time}Z` `` (`seriesTimeDialect.ts:36`,
and identically in SQL via `seriesSqlZone(...) = 'UTC'`), so its occurrence date is
`(start_at AT TIME ZONE 'UTC')::date` — **exactly**, with no DST subtleties, because UTC has none.
A team-local event was built as `(dateStr + time) @ tz`, so its occurrence date is
`(start_at AT TIME ZONE tz)::date`. Statement B sees only UTC-dialect events (by the restriction),
so it uses the UTC date. `src/api/team-settings.ts` sees only team-local events (by its
`AND es.times_are_team_local`), so it correctly uses the team-local date. **The two are not
supposed to be identical expressions** — they are the same rule applied to different populations.

**Defect 1 — near-midnight series jump ~a day.** `Europe/Prague`, `start_date 2026-01-06` (+1),
stored `start_time 22:00`, materialized summer occurrence `2026-07-07T22:00:00Z` (+2). Executed:

| | value |
|---|---|
| Statement A → `start_time` | `23:00:00` |
| local date of the old `start_at` | `2026-07-08` (not `07-07` — 22:00Z is 00:00 next day at +2) |
| withdrawn B (team-local date) | `2026-07-08 21:00:00+00` — **+23 h** |
| recommended B (UTC date) | `2026-07-07 21:00:00+00` — **−1 h** |
| what the fixed cron will regenerate | `2026-07-07 21:00:00+00` |

The withdrawn form moves the event nearly a full day and disagrees with regeneration. Reachable for
any team-local training starting between midnight and ~02:00 (late ice slots are real). Test B8.

**Defect 2 — it perturbs already-correct rows.** An already-`TRUE` series' events were materialized
by the post-#650 JS resolver, which uses `"compatible"` disambiguation and picks the **earlier**
instant in the fall-back repeated hour; Postgres `AT TIME ZONE` picks the **later**
(`applications/server/AGENTS.md` → "JS and Postgres Disagree On DST-Ambiguous Wall Clocks";
re-verified: `2026-10-25 02:30 Europe/Prague` → `01:30Z` in PG). The withdrawn form therefore
shifts correct rows by an hour and can only ever make them worse. Test B7.

The recommended form also **simplifies** the SQL: the date side needs no timezone at all, so there
are two `<TZ>` subselects instead of four.

#### B.2 Optional extra guard

`AND NOT e.all_day` costs nothing and prevents a hypothetical all-day event carrying a `series_id`
from having its team-midnight anchor (`all_day_anchored`, `1791400000`) overwritten with a series
clock time. `EventHorizonCron` never sets `all_day`, so this is unreachable today. Mention it in
the PR either way: `team-settings.ts`'s two re-anchor statements *also* fail to exclude each
other's population, so such a row would be re-anchored twice there. Pre-existing; not this PR.

### Statement C — flip the column default — **DROPPED, do not implement**

> **Decision: Statement C is cut.** Three reasons, the third decisive:
>
> 1. **No reachable writer depends on it.** `EventSeriesRepository.ts:136` is the only writer of
>    `event_series` in the tree (`grep -rn "INSERT INTO event_series"` finds it plus one test
>    helper) and it names the column explicitly. No seed, no fixture, no bot path relies on the
>    default.
> 2. **It puts the DB default in disagreement with the API's**, whose decoding default is `false`.
> 3. **It creates an unrecoverable rollback hazard.** With `DEFAULT TRUE`, a `majnet deploy
>    rollback` past Release N — exactly the operation that reverts the digest but *not* the data —
>    leaves an image that omits the column writing UTC-dialect times into rows silently marked
>    `TRUE`. That permanently violates `applications/server/AGENTS.md` rule 6's "every `FALSE` row
>    is genuinely UTC-semantics" invariant, in the direction no later migration can detect or
>    repair. Dropping C removes the failure mode entirely.
>
> Consequently: test cases C1–C3 are cut, and §E's only "CI goes red" row disappears — tests 2
> and 3 of `addSeriesTimesTeamLocalFlag.test.ts` seed via `insertRawSeriesWithoutFlag` and assert
> `false`, which stays true with the default unchanged.
>
> The original text is kept below for the record only. **Do not implement it.**

#### (superseded) Statement C — flip the column default

```sql
ALTER TABLE event_series ALTER COLUMN times_are_team_local SET DEFAULT TRUE
```

**Guard: none needed.** `SET DEFAULT` is unconditional and idempotent — running it twice is a
no-op, and it takes only a brief `ACCESS EXCLUSIVE` lock on the catalog entry (no table rewrite).

**Why it is safe *given* the §D check.** The default is only reached by a writer that omits the
column. Every writer in Release N and N+1 names it explicitly
(`EventSeriesRepository.insertEventSeries`, `:139`/`:144`). The only image that would land on the
default is one older than Release N — which writes UTC-dialect times and must get `FALSE`.
§D's image check is therefore a **hard precondition** for this statement, not a nicety.

**Honest reservation — this is the one statement I would consider dropping.** After it ships, the
DB default (`TRUE`) disagrees with the API decoding default: `EventSeriesApi.ts:118`/`:155` decode
an absent `timesAreTeamLocal` key to `false`, and rule 1 explicitly says a client that omits the
flag "still creates `FALSE` rows after the conversion has run". So Statement C is a no-op for every
reachable path and creates a documented disagreement between two defaults. Arguments to keep it:
`DEFAULT FALSE` becomes a trap once conversion is done (a future `INSERT` that forgets the column
silently means "legacy UTC"), and `docs/database.md:2218` specifies it. **Recommendation: keep it,
and open a follow-up to flip `withDecodingDefaultKey(() => true)` in a later release** so the two
defaults agree. If the reviewer prefers, dropping Statement C changes nothing functional.

**Statement C breaks two existing tests** — see §E.

### Assembled file

`packages/migrations/src/before/1792100000_series_time_is_team_local.ts`, style copied from
`1791700000` (`Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Effect.Do.pipe(...))`,
never `Effect.gen`):

```typescript
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Statement A
    Effect.bind('converted', () => sql<{ readonly id: string }>`UPDATE event_series es ... RETURNING es.id`),
    // Statement B — only the series A just converted
    Effect.tap(({ converted }) =>
      sql`UPDATE events e ... AND es.id = ANY(${converted.map((r) => r.id)}::uuid[]) ...`),
    // Statement C
    Effect.tap(() => sql`ALTER TABLE event_series ALTER COLUMN times_are_team_local SET DEFAULT TRUE`),
  ),
);
```

No `as` casts, no `any`. The doc comment should carry: the anchor argument, the `AT TIME ZONE`
direction argument, the dialect-recovery principle from §B.1, the guard-on-a-fact rule, the
`personal_messages_dirty_at` optimistic-concurrency reasoning, and an explicit "do not copy
`team-settings.ts`'s date expression here, and do not copy this one there".

---

## B. The ordering constraint — verified, and now stronger

`applications/server/AGENTS.md` rule 5 claims: *"Statement B itself needs no such predicate:
`1792100000`'s conversion migration runs Statement A (converting every `FALSE` row to
`TRUE`-semantics) before Statement B, so by the time Statement B runs, every row it touches is
already genuinely `TRUE`."*

**Verified correct as far as it goes.** Statement B reads `es.start_time`/`es.end_time` and
resolves them with `AT TIME ZONE <team zone>` — i.e. it assumes wall-clock semantics. If B ran
before A, it would resolve a UTC time-of-day in the team zone and shift every event by the team's
offset, which is precisely the pre-#650 bug reintroduced. So A **must** precede B.

**But the claim is incomplete, and becomes stale with the recommended design.** §B.1 shows B also
needs to know *which* rows were just converted, because the occurrence-date recovery differs by
dialect. So:

- **The dependency is now a data dependency, not a comment.** Statement B consumes Statement A's
  `RETURNING es.id`. The ordering is enforced by the `Effect.Do` bind chain and by the type
  system — a developer cannot reorder them without a compile error. This is strictly better than a
  prose invariant, and it is the reason to prefer the `RETURNING` shape over a temp table or a
  data-modifying CTE.
- **Rule 5's last sentence must be updated when this ships** (see §E): Statement B *does* carry a
  fifth predicate now, just a different one (`es.id = ANY(convertedIds)` rather than
  `AND es.times_are_team_local`), and its date expression deliberately differs from
  `team-settings.ts`'s. The four *shared* guards (`series_id`, `NOT series_modified`,
  `status = 'active'`, `start_at >= now()`) remain identical between the two sites and must stay so.

**Transaction-level ordering.** `Migrator.js` wraps the whole pending-migration set in one
`sql.withTransaction(run)` and takes `LOCK TABLE migrations_before IN ACCESS EXCLUSIVE MODE`
first. So A, B and C commit atomically, and two containers booting concurrently serialize (the
loser re-reads the applied id and skips). Statement C's DDL is transactional in Postgres too.

---

## C. Correctness hazards

**C1 — Spring-forward gap.** Statement A cannot hit it (instant → local is total). Statement B can:
a converted wall clock inside the gap has no local instant. Postgres pushes forward:
`(DATE '2026-03-29' + TIME '02:30') AT TIME ZONE 'Europe/Prague'` = `01:30Z` = `03:30` CEST.
`resolveOccurrenceInstant`'s `"compatible"` disambiguation does the same. **The two agree** — no
divergence. Test B12 pins it so a future `AT TIME ZONE` behaviour change is caught.

**C2 — Fall-back ambiguity.** `(DATE '2026-10-25' + TIME '02:30') AT TIME ZONE 'Europe/Prague'` =
`01:30Z` (the **later**, post-transition instant). `resolveOccurrenceInstant` picks `00:30Z` (the
**earlier**). **They disagree by one hour** — documented, not fixable in one place. Consequence: an
occurrence whose converted wall clock lands in the repeated hour is migrated to `01:30Z`, while
regeneration would produce `00:30Z`. One occurrence per zone per year, self-healing on the next
series edit. Test B11 pins the Postgres value. Do **not** "fix" either side alone; the three notes
(`resolveOccurrenceInstant`, `EventsRepository.updateFutureUnmodified`, `recomputeStartAt` in
`test/EventSeries.test.ts`) must move together.

**C3 — `start_date` on a different DST side from today.** This is the *normal* case, and the whole
reason `start_date` is the anchor rather than `CURRENT_DATE`. Prague `17:00` anchored in January
→ `18:00`; the same value anchored in July → `19:00`. A series created in winter and migrated in
summer gets `18:00`, and every summer occurrence moves back one hour — **that is the bug fix**, and
it is visible to captains. Release-notes item, not a defect. Test A9.

**C4 — Team timezone NULL / missing / empty / unrecognised.**
- No `team_settings` row → subselect returns NULL → `COALESCE` → `'Europe/Prague'`. (An
  `UPDATE ... FROM` would have skipped the row silently. Tests A3, B15.)
- `timezone = 'Mars/Olympus'` → not in `pg_timezone_names` → join yields no row → NULL → fallback.
  Without the join this raises `22023` and **server boot fails for every team**. Test A4.
- `timezone = ''` → same path; a distinct input worth its own case because `AT TIME ZONE ''` is a
  different parse failure. Test A5.
- `timezone = 'europe/prague'` (wrong case) → `=` is case-sensitive → falls back to
  `'Europe/Prague'`. Deliberately **not** `ILIKE`. Test A6 uses lowercase `'america/new_york'` so
  fallback (`00:00:00`) and `ILIKE` (`18:00:00`) give different answers.
- Note `team_settings.timezone` can hold values the API validator accepts but the join rejects
  (`EST`, `UTC+3`) — `applications/server/AGENTS.md` rule 4 enumerates the three disagreeing
  validators. All of them land on the fallback here, matching `resolveOccurrenceInstant`.

**C5 — Series whose team no longer exists.** **Unreachable.** `event_series.team_id` is
`NOT NULL REFERENCES teams(id) ON DELETE CASCADE` (`1741500000_create_event_series.ts:9`), so the
series dies with the team. The reachable analogue is C4's "team exists, no `team_settings` row".
Likewise `events.series_id REFERENCES event_series(id) ON DELETE SET NULL`, so a deleted series
leaves `series_id NULL` and Statement B's join excludes the event. No orphan handling needed.

**C6 — `end_time IS NULL`.** Statement A's `CASE` returns NULL; without the `CASE`,
`start_date + NULL` is NULL anyway, so the `CASE` is documentation rather than protection — say so
honestly and do not claim test A10 "catches" it. What A10 *does* catch: an implementation that
`COALESCE`s `end_time` to a literal, and it confirms `start_time` still converts and the flag still
flips for such a row. Statement B sets `end_at = NULL` when `es.end_time IS NULL`, matching
`EventsRepository.updateFutureUnmodified:722`'s `ELSE NULL`. Conversely, when `es.end_time` is
non-NULL and the event's `end_at` was NULL, B **fills it in** — also matching that repository
query. Both are behaviour changes worth a test (B9) and a line in the migration's doc comment.

**C7 — `end_time` crossing midnight relative to `start_time`.** Both columns convert
independently, so ordering is preserved: Prague, January anchor, `22:00`/`01:00` → `23:00`/`02:00`
(executed). Note the pre-existing modelling quirk: `EventHorizonCron` resolves `end_at` on the
**same** `dateStr` as `start_at` (`EventHorizonCron.ts:41`–`:48`), so a genuinely crossing series
materializes `end_at < start_at`. Statement B reproduces that exactly by anchoring `end_at` on
`start_at`'s occurrence date. Do **not** "fix" midnight crossing here — it would diverge from what
the cron regenerates the next day. Test A12.

**C8 — Rows already `TRUE` must be untouched.** Statement A: guaranteed by
`WHERE NOT es.times_are_team_local` (test A11). Their **events**: guaranteed only by the
recommended form's `es.id = ANY(convertedIds)` restriction. Under the withdrawn form they are
rewritten and can shift by an hour (C2) — test B7 is the test that forces this design choice.
Population: `testing` carries such rows (written by a previewed server); production should carry
a **growing** population — every series created since `@sideline/web@v0.38.0` writes `timesAreTeamLocal: true` straight through (`TrainingTypeDetailPage.tsx:214`, `EventsListPage.tsx:309` → `EventSeriesRepository.ts:139`). This is normal, it is exactly why Statement B is restricted to Statement A's `RETURNING`, and it is **not** an abort trigger. The earlier "approximately zero" claim was stale and contradicted this document's own urgency argument, which depends on that same web release — **verify with the §G
pre-flight query rather than assuming**.

**C9 — Partial run.** The entire pending-migration set runs inside one
`sql.withTransaction(run)` (`node_modules/effect/dist/unstable/sql/Migrator.js`), and the
`INSERT` into `migrations_before` is inside that same transaction. So an interruption — SIGKILL,
OOM, connection drop, deploy timeout — rolls back **everything**, including the recorded migration
id and Statement C's DDL. There is no half-converted state reachable via the migrator. Test
X1 proves this.
The reachable partial-run risk is an **operator running the statements by hand in psql with
autocommit**: A commits, B does not. Recovery is: re-running A is a no-op (guard), and B's
`convertedIds` is then empty, so the events are *not* re-anchored by a naive re-run. The operator
must instead run B with an explicit id list, or wait for regeneration
(≤ `event_horizon_days`, default 14). **Write this into the migration's doc comment** — it is the
one genuinely sharp edge of the restricted design, and it is the price of B7/B8 correctness.

**C10 — Lock footprint.** The transaction holds row locks on every converted `event_series` row and
every re-anchored `events` row until boot completes, plus `ACCESS EXCLUSIVE` on
`migrations_before`. At Sideline's scale (see §G for the counts) this is milliseconds. Confirm
with the §G pre-flight counts before running against production; if `to_convert` is unexpectedly
large (>100k), reconsider batching.

**C11 — `start_time` is `NOT NULL`, `start_date` is `NOT NULL`.** No NULL-propagation hazard on the
start side. `end_date` is nullable but unused by this migration.

**C12 — Cancelled series.** Converted by A (no status filter — see §A), their events skipped by B
(`status = 'active'`). Intentional. Test A14.

---

## D. Rolling-deploy safety — proof, not assumption

Production is blue-green with the previous container serving throughout
(`docs/deployment.md` §5.4). The premise of the two-release split is that the **Release N image
tolerates rows flipping to `TRUE` underneath it**. Verified path by path against the current tree
(which *is* the Release N code):

| Path | Evidence | Verdict |
|---|---|---|
| Occurrence materialization | `EventHorizonCron.ts:41`–`:48` calls `resolveSeriesOccurrenceInstant(dateStr, s.start_time, s.team_timezone, s.times_are_team_local)` | Dispatches per row. `TRUE` → `resolveOccurrenceInstant` in the team zone. **Correct.** |
| Series create read-back | `event-series.ts:143`–`:154` passes `inserted.times_are_team_local` | **Correct.** |
| Series update read-back | `event-series.ts:556`–`:567` passes `existing.times_are_team_local` | **Correct.** |
| SQL re-derivation on series edit | `event-series.ts:520` binds `seriesSqlZone(teamZone, existing.times_are_team_local)`; `TRUE` → team zone, `FALSE` → `'UTC'` | **Correct.** |
| Queries selecting a series time | `EventSeriesRepository.ts:162`, `:182`, `:203`, `:241` all select `es.times_are_team_local` alongside | **Correct.** |
| Team-timezone change re-anchor | `team-settings.ts:381` `AND es.times_are_team_local` | Previously a no-op for every row; after conversion it starts firing — and firing is the **correct** behaviour for a `TRUE` row. |
| Bot / iCal / personal channels | Read `events.start_at`, never `event_series.start_time` | Unaffected by A; corrected by B. |

A repo-wide grep for `` `${dateStr}T` `` / `Z` -pinned occurrence construction finds exactly one
site: `seriesTimeDialect.ts:36`, the deliberate `FALSE` branch. **No unguarded reader remains.**
Conclusion: a Release N container serving while `1792100000` commits reads `TRUE` rows correctly.
The split works.

### D.1 Hard precondition — production must already be on Release N

If the running production image is **older** than Release N (does not contain
`src/utils/seriesTimeDialect.ts`), it treats every `start_time` as UTC and will misread every
converted row, and Statement C will mislabel every series it creates. **Check both, not just one:**

1. `SELECT max(migration_id) FROM migrations_before;` on production — must be ≥ `1791700000`.
2. The currently-promoted digest (`majnet deploy progress`, or `apps/server/production.yaml`) must
   resolve to a build at or after `8546e266` (#652). Step 1 alone is insufficient: a
   `majnet deploy rollback` reverts the digest but not the recorded migration, so the DB can be
   ahead of the running image.

**If either check fails, do not merge.** Ship Release N to production first.

### D.2 The web bundle, and why nothing corrupts either way

`EventSeriesInfo` does **not** expose `timesAreTeamLocal` (only the Create/Update *requests* carry
it — `EventSeriesApi.ts:118`, `:155`), so the web cannot know a row's dialect and always renders
`startTime` verbatim.

- **If the deployed web is pre-#650** (uses `utcTimeToLocal(s.startTime)` — see the `0897f9a1`
  diff): after conversion it *displays* series times shifted by the viewer's browser offset —
  cosmetic and confusing, but on **edit** it sends no `timesAreTeamLocal` key → decodes `false` →
  `assertDialectMatches(false, TRUE)` → **HTTP 400 `EventSeriesTimeDialectMismatch`**. The write is
  rejected, not corrupted. The dialect assert is the safety net, and it works in this direction.
- **If the deployed web is post-#650** (current tree: `timesAreTeamLocal: true` on create *and*
  update, `TrainingTypeDetailPage.tsx:302`, `EventsListPage.tsx:309`, `EventDetailPage.tsx:369`):
  today, with every row `FALSE`, **any series time edit is already failing with 400**, and rendered
  series times are already an offset off. **This migration is what unblocks them.** That is the
  strongest argument for shipping promptly.

Either way there is no data-corruption window — only a rejected-write window. Release the web in
the same release as, or immediately after, this migration.

---

## E. File-by-file change list

### New

| Path | What |
|---|---|
| `packages/migrations/src/before/1792100000_series_time_is_team_local.ts` | The migration. Doc comment per §A. |
| `applications/server/test/integration/migrations/seriesTimeIsTeamLocal.test.ts` | Integration test per §F. (Filename is free — the old one was deleted in `8546e266`.) |

### Must change or CI goes red

| Path | What |
|---|---|
| `applications/server/test/integration/migrations/addSeriesTimesTeamLocalFlag.test.ts` | **Tests 2 and 3 break under Statement C.** The integration DB is bootstrapped with the full migration set, so once `1792100000` runs, the live column `DEFAULT` is `TRUE`; both tests seed via `insertRawSeriesWithoutFlag` (which deliberately omits the column) and assert `times_are_team_local === false`. Fix by giving tests 2 and 3 the same `dropTimesAreTeamLocalColumn()` + `runMigration()` prelude test 1 already has, so the default under test is `1791700000`'s own. Do **not** "fix" it by naming the column in the helper — that destroys what the helper is for. |

### Documentation — all of these say "not yet in the tree"

| Path | What |
|---|---|
| `docs/database.md` :2218 | Drop `*(pending, follow-up release)*` and "Not yet in the tree as of this document's last update — do not search for this file until it ships." Rewrite the row to describe the **shipped** statements, including B's restriction to just-converted series and its UTC-date recovery. Keep the renumbering history sentence. |
| `docs/database.md` :553 | `event_series` notes: past tense; state that after this migration essentially every row is `TRUE` but the `FALSE` branch is permanent (rule 1); repoint the `.work-plans/` citation (§0.1). |
| `packages/migrations/AGENTS.md` :104 | "the guarded conversion `UPDATE` lands separately in `1792100000`" → landed. |
| `packages/migrations/AGENTS.md` :106 | Keep the renumbering blockquote as history; past tense. |
| `packages/migrations/AGENTS.md` :126 | "that migration is NOT in the tree yet" → it is, and it is now **the** reference implementation of `pg_timezone_names`-inside-`COALESCE`. Keep the warnings about `1791400000` and `1792000005` being partial patterns. |
| `applications/server/AGENTS.md` :1108 | Two-release split is complete; repoint the `.work-plans/` citation. |
| `applications/server/AGENTS.md` :1112 (rule 1) | The `FALSE`-branch carve-out is permanent — reaffirm, do not weaken. |
| `applications/server/AGENTS.md` :1116 (rule 5) | **Substantive.** Replace "Statement B itself needs no such predicate" with the §B.1 dialect-recovery principle: the four shared guards stay identical between the two sites; the date expressions deliberately differ (`AT TIME ZONE 'UTC'` in the migration, `AT TIME ZONE oldTz` in `team-settings.ts`) because each sees a different dialect population. Add the explicit "do not align them". |
| `applications/server/AGENTS.md` :1117 (rule 6) | The "every `FALSE` row is genuinely UTC-semantics" invariant still matters for any future conversion; reword from "`1792100000`'s guard depends on it" to the general form. |
| `applications/server/src/api/team-settings.ts` :345–:353 | Past tense; add the one-line "why our date expression differs from the migration's". |
| `applications/server/src/utils/seriesTimeDialect.ts` :23–:26 | "Release N ships no migration that converts rows … almost every row reaching this function today takes the `FALSE` branch" is now false. Rewrite. |
| `docs/deployment.md` :374 | Already reads fine as history; optionally past-tense the worked example. |
| `applications/server/test/integration/api/teamSettingsReanchor.test.ts` :332–:338, :851–:857 | Stale comments ("`insertEventSeries` never names this column", "the DB column default, which is FALSE this release"). Tests still **pass** — `seedSeries` passes `timesAreTeamLocal` explicitly. Comment-only fix. |

### Deliberately unchanged

`packages/migrations/src/before/1791700000_...ts` (its doc is accurate history),
`src/utils/seriesOccurrence.ts` (its `1792100000` citation becomes correct rather than forward-looking),
`packages/domain/**` (no schema change → **no `pnpm build` of `packages/domain` needed**).

---

## F. Test specification

**File:** `applications/server/test/integration/migrations/seriesTimeIsTeamLocal.test.ts`
**Harness:** copy `addSeriesTimesTeamLocalFlag.test.ts` exactly — deep default-import
`@sideline/migrations/before/1792100000_series_time_is_team_local`, `TestPgClient`,
`beforeEach(cleanDatabase)`, `it.effect`, `Effect.Do.pipe` (never `Effect.gen`), raw `INSERT` for
pre-migration row shapes. Add `TeamSettingsRepository` to the layer and reuse the withdrawn test's
`setupTeam(guildId, timezone?)` (a `timezone` of `undefined` creates **no** `team_settings` row),
`insertRawSeries`, `insertRawSeriesEvent`, `readSeriesRow`, `readEventRow` helpers from
`0897f9a1:applications/server/test/integration/migrations/seriesTimeIsTeamLocal.test.ts`.
`const runMigration = () => seriesTimeIsTeamLocal;` — each reference is a fresh execution.

Two harness additions the withdrawn file lacked:
- `insertRawSeries` needs a `timesAreTeamLocal?: boolean` parameter (default: omit the column) so
  A11/B7 can seed a genuinely pre-`TRUE` row.
- a `readColumnDefault()` helper: `SELECT column_default FROM information_schema.columns WHERE
  table_name = 'event_series' AND column_name = 'times_are_team_local'`.

Every case below states **what it catches** — a test that still passes with the statement deleted
does not belong here. Three vacuous tests were found in this repo today; the two weakly-discriminating
cases below (A10, B14) are labelled as such rather than oversold.

Unless stated otherwise: team zone `Europe/Prague`, `start_date 2026-01-06` (CET, +1),
`start_time '17:00:00'`. Distinct guild id per case, as in the existing files.

### Statement A

| # | Case | Setup → expected | Catches |
|---|---|---|---|
| A1 | happy path | `17:00` → `start_time = '18:00:00'`, `times_are_team_local = true` | Statement A deleted; `AT TIME ZONE` operands swapped (would give `16:00`). |
| A2 | **idempotence** | run migration **twice** → still `18:00:00` (not `19:00`) | `WHERE NOT es.times_are_team_local` missing, or the flag set in a separate statement. The single most important case in the file. |
| A3 | no `team_settings` row | `setupTeam(g)` with no timezone → `18:00:00`, `true` | `UPDATE ... FROM team_settings` (inner join) — the row would stay `17:00`, `false`. |
| A4 | unrecognised zone | `'Mars/Olympus'` → migration **does not throw**, `18:00:00` | Missing `pg_timezone_names` join → `22023`, migration aborts, **server boot fails**. |
| A5 | empty-string zone | `''` → does not throw, `18:00:00` | Same defence, different parse failure. |
| A6 | wrong-case zone (**non-vacuous**) | `'america/new_york'`, `start_time '23:00:00'` → `00:00:00` (Prague fallback), **not** `18:00:00` | Someone "fixing" `=` to `ILIKE`. The two answers differ by 18 h — verified. |
| A7 | **negative offset** (mandate) | `America/New_York`, `23:00` → `18:00:00` | Whole-zone hard-coding; the west-of-UTC anchor-overflow bug class from `seriesOccurrence.ts`'s doc. |
| A8 | **non-whole-hour** (mandate) | `Asia/Kathmandu` (+5:45), `12:30` → `18:15:00` | Any hour-granularity arithmetic. |
| A9 | **anchor is `start_date`, not today** | two series, same team (`Europe/Prague`), same `start_time '17:00'`, `start_date` `2026-01-06` vs `2026-07-07` → `18:00:00` and `19:00:00` | `CURRENT_DATE`/`now()` anchoring — both rows would get the same value whichever half of the year CI runs in. Pair with `Australia/Lord_Howe` (`04:00:00` in Jan vs `03:30:00` in Jul) for the 30-minute DST step. |
| A10 | `end_time NULL` *(weakly discriminating — say so in the comment)* | `end_time = NULL` → stays NULL, `start_time` → `18:00:00`, flag `true` | A `COALESCE(end_time, ...)`; a NOT NULL violation. Does **not** meaningfully test the `CASE` (NULL propagates anyway). |
| A11 | **pre-existing `TRUE` row untouched** | insert with `times_are_team_local = TRUE`, `start_time '17:00:00'` → still `17:00:00` | A guard weakened to "convert everything". Distinct from A2: this row was never converted. |
| A12 | crossing midnight | `22:00` / `01:00` → `23:00:00` / `02:00:00` | An implementation deriving `end_time` as `start_time + duration`, or anchoring `end_time` on a different date. Both columns convert independently. |
| A13 | southern hemisphere day roll | `Australia/Sydney`, Jan, `17:00` → `04:00:00` | A `::timestamp` that leaks the rolled date, or a guard that rejects the roll. |
| A14 | cancelled series still converts | `event_series.status = 'cancelled'` → `18:00:00`, `true` | Someone adding `AND es.status = 'active'`, which would leave a lying marker. |

### Statement B

Series: Prague, `start_date 2026-01-06`, `start_time '17:00:00'`, `end_time '19:00:00'`
(→ `18:00`/`20:00` after A). Event: `start_at 2027-07-07T17:00:00Z`, `end_at 2027-07-07T19:00:00Z`
— a summer occurrence materialized from the winter-stored UTC value, i.e. the exact stranded shape
the bug produces.

| # | Case | Expected | Catches |
|---|---|---|---|
| B1 | future / active / unmodified | `start_at = 2027-07-07T16:00:00.000Z`, `end_at = 2027-07-07T18:00:00.000Z`, `personal_messages_dirty_at` non-null | Statement B deleted; wrong zone on either side of the round trip. Verified in PG. |
| B2 | `series_modified = true` | unchanged `…T17:00:00.000Z`, dirty **null** | Missing `NOT e.series_modified` — would clobber a captain's override. |
| B3 | `status = 'cancelled'` | unchanged, dirty null | Missing `status = 'active'`. |
| B4 | `status = 'started'` | unchanged, dirty null | A guard written as `status <> 'cancelled'` instead of `= 'active'`. |
| B5 | past occurrence | `2020-07-07T17:00:00Z` (series `start_date 2020-01-06`) unchanged, dirty null | Missing `start_at >= now()` — would rewrite history. |
| B6 | standalone event (`series_id NULL`) | unchanged, dirty null | A `WHERE` that lost the join. |
| B7 | **event of an already-`TRUE` series** | series seeded `TRUE` with `start_time '18:00:00'`, event at `2027-07-07T16:00:00Z` → unchanged, dirty **null** | **The withdrawn Statement B fails this.** Proves B only touches series A just converted. |
| B8 | **near-midnight, no day jump** | `start_date '2027-01-05'`, `start_time '22:00'` (→ `23:00` after A), event `2027-07-06T22:00:00Z` → **`2027-07-06T21:00:00.000Z`** | The withdrawn local-date recovery gives `2027-07-07T21:00:00.000Z` (+23 h). Verified in PG. The single most valuable new case. **Dated 2027 deliberately** — B's guard is `start_at >= now()`, and the original 2026 fixture was already in the past, so the case never ran at all. |
| B9 | `end_at` handling | (a) `es.end_time NULL` + event `end_at` non-null → `end_at` becomes NULL; (b) `es.end_time` non-null + event `end_at` NULL → filled in on `start_at`'s occurrence date | Either half silently dropped; an `end_at` anchored on its own date instead of the occurrence date. Both behaviours are intentional and mirror `updateFutureUnmodified`. |
| B10 | **re-run is a provable no-op** | after run 1 capture `start_at` **and** `personal_messages_dirty_at`; run again → **both byte-identical** | An unrestricted B that re-stamps `dirty_at` every run (the withdrawn form fails the timestamp assertion), and a double-shifted `start_at`. |
| B11 | fall-back ambiguity | `start_date '2027-07-07'`, stored `start_time '00:30'` (→ `02:30` after A), event `2027-10-31T00:30:00Z` → **`2027-10-31T01:30:00.000Z`** — it **moves** | Pins the documented JS/PG disagreement so a future `AT TIME ZONE` change surfaces here; comment must name the JS answer. **Anchored on the other DST side on purpose**: with `start_date` in the same offset as the occurrence the row came back byte-identical to its seed, so the case passed with Statement B deleted. |
| B12 | spring-forward gap | `start_date '2027-07-07'`, stored `start_time '00:30'` (→ `02:30` after A), event `2027-03-28T00:30:00Z` → **`2027-03-28T01:30:00.000Z`** — it **moves** | Same; here the two engines **agree** — assert it so a divergence is caught. Original fixture was both past-dated *and* non-discriminating: the seeded value equalled the asserted value, so it passed green while testing nothing. |
| B15 | **unique-index collision (blocker 1)** | one series, two occurrences on **adjacent** UTC dates, converted clock rolls the UTC date (e.g. Prague `00:30`) | Fails against the pre-fix spec with `duplicate key value violates unique constraint idx_events_series_date`. This is the case whose absence let a boot-failure-in-production survive six reviews — no other case has a series with more than one occurrence. |
| B13 | **negative offset** (mandate) | `America/New_York`, series `23:00` → `18:00`, event `2027-07-07T23:00:00Z` → `2027-07-07T22:00:00.000Z` | Zone hard-coded to an eastern offset. Verified in PG. |
| B14 | **non-whole-hour** (mandate) *(no-op by construction — assert the stamp)* | `Asia/Kathmandu`, series `12:30` → `18:15`, event `2027-07-07T12:30:00Z` → **unchanged**, but `personal_messages_dirty_at` **non-null** | A fixed-offset zone can never move under B, so the instant assertion alone is vacuous; the dirty stamp proves the row was matched, and the instant proves the `:45` offset round-trips. |
| B15 | no `team_settings` row | team with no settings row; series/event as B1 → re-anchored via the Prague fallback | An inner join in **B** (A3 only covers A). |

### Statement C

| # | Case | Expected | Catches |
|---|---|---|---|
| C1 | default flipped | after the migration, `information_schema.columns.column_default` for `times_are_team_local` is `true` | Statement C deleted. |
| C2 | behavioural default | raw `INSERT INTO event_series (...)` **omitting** the column → row reads `times_are_team_local = true` | A `SET DEFAULT` that targeted the wrong column/table. |
| C3 | re-run | run migration twice → no error, default still `true` | Non-idempotent DDL. |

### Cross-cutting

| # | Case | Expected | Catches |
|---|---|---|---|
| X1 | ~~rows unchanged after a rolled-back transaction~~ | **CUT — vacuous.** It passes with Statements A and B deleted: it tests Effect's `sql.withTransaction` and Postgres's transactional DDL, not this migration, and violates this document's own rule that a test must fail when its statement is removed. The C9 atomicity guarantee survives as a doc comment citing `Migrator.js`. |
| X2 | full-run fidelity | one team, six series spanning A1/A7/A8/A9/A12/A14 plus their events → one migration run, assert every row | Per-row `UPDATE` logic that only works when the table has one row (e.g. a mis-correlated subselect). |

### Required layers / fixtures

`Layer.mergeAll(TeamMembersRepository.Default, TeamSettingsRepository.Default,
TeamsRepository.Default, UsersRepository.Default).pipe(Layer.provideMerge(TestPgClient))`.
No mocks — this is a real-Postgres suite. Note the repo memory: **the integration suite is serial**;
overlapping runs deadlock and mimic real failures. Run it alone.

---

## G. Operator verification

### G.1 Pre-flight (read-only, run **before** the deploy)

```sql
-- 1. Scale: how many series will Statement A convert?
SELECT count(*) FILTER (WHERE NOT times_are_team_local) AS to_convert,
       count(*) FILTER (WHERE     times_are_team_local) AS already_true,
       count(*)                                          AS total
FROM event_series;

-- 2. Scale: how many events will Statement B touch (upper bound, before the restriction)?
SELECT count(*) AS events_in_scope
FROM events e JOIN event_series es ON es.id = e.series_id
WHERE NOT es.times_are_team_local
  AND NOT e.series_modified AND e.status = 'active' AND e.start_at >= now();

-- 3. Full preview of Statement A — old vs new, per row, WITHOUT writing anything.
--    `crosses_day = true` marks the series discussed in §B.1/C7: their materialized
--    occurrences move furthest. Warn those teams' captains.
SELECT es.id, es.team_id, es.title, es.start_date, z.tz,
       es.start_time AS old_start,
       ((es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME ZONE z.tz)::time AS new_start,
       es.end_time   AS old_end,
       CASE WHEN es.end_time IS NULL THEN NULL
            ELSE ((es.start_date + es.end_time) AT TIME ZONE 'UTC' AT TIME ZONE z.tz)::time END AS new_end,
       ((es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME ZONE z.tz)::date <> es.start_date AS crosses_day
FROM event_series es
CROSS JOIN LATERAL (
  SELECT COALESCE((SELECT ts.timezone FROM team_settings ts
                     JOIN pg_timezone_names n ON n.name = ts.timezone
                    WHERE ts.team_id = es.team_id), 'Europe/Prague') AS tz
) z
WHERE NOT es.times_are_team_local
ORDER BY crosses_day DESC, es.team_id;

-- 3b. MANDATORY — unique-index collision pre-flight. Any row returned here is a
--     BOOT FAILURE on deploy (see the blocker note under Statement B) and must be
--     hand-resolved BEFORE this migration merges. Empty result = safe to ship.
--     A non-empty result means two occurrences of one series would occupy the same
--     (series_id, UTC date) slot mid-statement; `conflicts_with` names the sibling,
--     and its `status` tells you whether B would have skipped it (cancelled/modified
--     rows still hold their slot — the partial index has no status predicate).
WITH z AS (
  SELECT es.id AS series_id,
         COALESCE((SELECT ts.timezone FROM team_settings ts
                     JOIN pg_timezone_names n ON n.name = ts.timezone
                    WHERE ts.team_id = es.team_id), 'Europe/Prague') AS zone
  FROM event_series es
  WHERE NOT es.times_are_team_local
), moved AS (
  SELECT e.id, e.series_id,
         (e.start_at AT TIME ZONE 'UTC')::date AS old_date,
         ((((e.start_at AT TIME ZONE 'UTC')::date
             + ((es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME ZONE z.zone)::time)
            AT TIME ZONE z.zone) AT TIME ZONE 'UTC')::date AS new_date
  FROM events e
  JOIN event_series es ON es.id = e.series_id
  JOIN z ON z.series_id = es.id
  WHERE NOT e.series_modified AND e.status = 'active' AND e.start_at >= now()
)
SELECT m.series_id, m.id, m.old_date, m.new_date,
       o.id AS conflicts_with, o.status, o.series_modified
FROM moved m
JOIN events o ON o.series_id = m.series_id AND o.id <> m.id
             AND (o.start_at AT TIME ZONE 'UTC')::date = m.new_date
WHERE m.new_date <> m.old_date;

-- 4. Teams whose timezone will hit the fallback (missing row, or a value PG will not accept).
SELECT t.id, t.name, ts.timezone,
       CASE WHEN ts.team_id IS NULL THEN 'no team_settings row' ELSE 'unrecognised zone' END AS reason
FROM teams t
LEFT JOIN team_settings ts ON ts.team_id = t.id
WHERE ts.team_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = ts.timezone);

-- 5. §D.1 precondition.
SELECT max(migration_id) AS applied_waterline FROM migrations_before;  -- must be >= 1791700000
```

**Abort criteria**, in order of severity:

1. **Query 3b returns any row — unconditional blocker.** Each one is a boot failure on deploy.
   Hand-resolve before merging (see the blocker note under Statement B).
2. **Query 5 below `1791700000` — unconditional blocker.** Release N has not reached this
   environment.
3. **Query 4 returns a team that owns any `event_series` row — blocker until hand-resolved.**
   Originally informational; promoted to an abort criterion by review. The reason is that this
   fallback is *not* like the cron's. A case-variant or abbreviated zone (`america/new_york`,
   `EST`) passes `team_settings_timezone_check`, passes `DateTime.makeZoned`, and is resolved
   **correctly to New York** by every other consumer — the migration's case-sensitive
   `n.name = ts.timezone` join is the only site that falls back, so such a team's series would be
   converted with `Europe/Prague`: a six-hour error, written once, forward-only, and not
   self-healing the way a cron-path fallback is. Normalise the team's `timezone` to its exact
   `pg_timezone_names` spelling BEFORE deploying. A team that hits the fallback but owns zero
   series is harmless — check ownership, not just the row count. (Do **not** "fix" this by
   relaxing the join to `lower(...)` or `ILIKE`: the case-sensitive `=` is deliberate and test A6
   pins it, because silent normalisation is how a genuinely unrecognised zone stops being caught.)
4. Query 1's `already_true > 0` is **expected and fine**, not an abort: every series created since
   `@sideline/web@v0.38.0` is a genuine `TRUE` row, and the recommended Statement B excludes them.
   It *would* be a blocker with the withdrawn Statement B, which is one more reason not to use it.
5. Query 3's `crosses_day = true` rows are not an abort but **must be eyeballed by a human** —
   those occurrences move furthest, and the anchor caveat above means a captain who edited from a
   different timezone may land somewhere unintended.

**Expected scale.** Roughly one to a few `event_series` rows per team, and per series at most
`ceil(event_horizon_days / 7) × |days_of_week|` future events (default horizon 14 days → ~2–6).
For a few dozen teams that is O(100) series and O(1000) events; the transaction is milliseconds.
Query 1 and 2 give the real numbers — do not guess.

### G.2 Snapshot for the after-diff (run immediately before the deploy)

```sql
CREATE TABLE series_time_conversion_audit AS
SELECT e.id, e.series_id, e.start_at, e.end_at, e.personal_messages_dirty_at
FROM events e JOIN event_series es ON es.id = e.series_id
WHERE NOT es.times_are_team_local
  AND NOT e.series_modified AND e.status = 'active' AND e.start_at >= now();
```

This is the only rollback aid that exists (migrations are forward-only). Keep it for at least one
release, then drop it manually.

### G.3 Post-flight

```sql
-- 1. Conversion complete.
SELECT count(*) AS still_false FROM event_series WHERE NOT times_are_team_local;  -- expect 0

-- 2. Default flipped.
SELECT column_default FROM information_schema.columns
WHERE table_name = 'event_series' AND column_name = 'times_are_team_local';        -- expect 'true'

-- 3. How far did events actually move? Expect every delta in ±2h EXCEPT the rows
--    G.1 query 3 flagged `crosses_day`, which move by up to ~1 day by design.
SELECT count(*) AS touched,
       count(*) FILTER (WHERE e.start_at <> a.start_at)                   AS moved,
       min(e.start_at - a.start_at)                                       AS min_delta,
       max(e.start_at - a.start_at)                                       AS max_delta,
       count(*) FILTER (WHERE abs(extract(epoch FROM e.start_at - a.start_at)) > 7200) AS over_two_hours
FROM events e JOIN series_time_conversion_audit a ON a.id = e.id;

-- 4. Anything moved more than two hours, listed for eyeballing against G.1 query 3.
SELECT e.id, e.series_id, a.start_at AS was, e.start_at AS now_is, e.start_at - a.start_at AS delta
FROM events e JOIN series_time_conversion_audit a ON a.id = e.id
WHERE abs(extract(epoch FROM e.start_at - a.start_at)) > 7200
ORDER BY abs(extract(epoch FROM e.start_at - a.start_at)) DESC;

-- 5. Every touched event was marked for Discord re-render.
SELECT count(*) AS not_stamped
FROM events e JOIN series_time_conversion_audit a ON a.id = e.id
WHERE e.start_at <> a.start_at AND e.personal_messages_dirty_at IS NULL;          -- expect 0

-- 6. Spot-check one known team end to end.
SELECT es.title, es.start_time, es.times_are_team_local, e.start_at, e.end_at
FROM event_series es JOIN events e ON e.series_id = es.id
WHERE es.team_id = '<team-uuid>' AND e.start_at >= now()
ORDER BY e.start_at LIMIT 10;
```

Query 4's output should be **exactly** the set G.1 query 3 predicted with `crosses_day = true`. Any
other row there means Statement B did something unplanned — investigate before letting the
personal-events reconcile worker drain the dirty queue.

---

## H. Effort and the ship/no-ship call

### Effort

| Task | Estimate |
|---|---|
| Migration file (SQL is ~90 % recoverable from `0897f9a1`; the new work is Statement B's restriction + the doc comment) | 1.5 h |
| Integration test — 32 cases, real Postgres, every literal instant verified against PG | 4 h |
| Fix `addSeriesTimesTeamLocalFlag.test.ts` tests 2 and 3 | 20 min |
| Doc updates (13 files, several substantive — rule 5 in particular) | 1.5 h |
| Pre/post-flight queries, release-notes text, operator runbook | 1 h |
| CI, review, revision | 2 h |
| **Total** | **~1.5 focused days** |

Plus, before merge: the §D.1 production image check (10 min, needs `majnet` access) and the §G.1
pre-flight run against production (10 min).

### Is there any reason not to ship this?

**Reasons to ship now — all three are live defects that only this migration fixes:**

1. The DST bug itself: a `FALSE` row's "Tuesday 18:00" is read as UTC and is an hour wrong for half
   the year in every DST zone, in the calendar, in Discord and in the iCal feed.
2. The released web renders `startTime` verbatim as a wall clock, but every row is a UTC
   time-of-day — so displayed series times are currently off by the team's offset.
3. The released web sends `timesAreTeamLocal: true` on update, every stored row is `FALSE`, and
   `assertDialectMatches` rejects the mismatch — **editing a recurring series' time is currently
   broken with an HTTP 400** for every team. That failure is silent-ish to the captain (a generic
   toast) and is not going to be reported as "dialect mismatch".

**Genuine blockers — all checkable, none open-ended:**

- §D.1: production must already run a Release N image. If it does not, ship Release N first. This
  is a hard stop, not a risk to accept.
- §G.1 query 1: if production has `already_true > 0`, confirm you are shipping the **recommended**
  Statement B, not the withdrawn one.
- The design deviation in §B.1 needs your sign-off. It is the difference between "some teams' next
  fortnight of late-evening trainings jump a day" and "they shift an hour, which is the fix".

**Accepted, documented residuals** (none of them a reason to wait):

- Some teams' upcoming trainings visibly move by an hour. That is the bug fix; it belongs in the
  release notes with a short captain-facing explanation.
- An occurrence whose corrected wall clock lands in the fall-back repeated hour is migrated one
  hour later than regeneration would place it (C2). One occurrence per zone per year; self-heals.
- Forward-only. The only rollback aid is the §G.2 audit table; Statement A's documented inverse
  (restore `FALSE`, apply the opposite `AT TIME ZONE`) is only valid for teams whose timezone has
  not changed since.

**Verdict: ship it, once §D.1 passes AND §G.1 query 3b returns empty.** Waiting costs more than
shipping — every day of delay is another day of wrong training times in members' Discord channels
and another day of rejected edits.

On that second point, the scope is **worse than "time edits"**, and this was verified against the
shipped code: the schedule form sends `startTime: Option.some(...)` **unconditionally**
(`TrainingTypeDetailPage.tsx:291`, `EventDetailPage.tsx`), and `event-series.ts:402` calls
`assertDialectMatches` whenever `Option.isSome(payload.startTime)`. Against an all-`FALSE` table
that means **every recurring-series edit is returning HTTP 400 in production right now** — a
title-only, location-only or days-of-week-only change included. This migration is what unblocks
them. Confirm the rollout with `majnet deploy progress`: a git tag proves the code exists, not that
it is promoted. Deploy order: **migration + server together, web in the same release or
immediately after.** Nothing corrupts if web lags; edits just keep returning 400 until it catches up.
